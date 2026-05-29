import { createBgzfBlock, decompressGzipChunk } from './bgzf';
import type { Env, TarGzIndexEntry } from './types';

const archivePath = '/photos.tar.gz';
const indexPath = '/photos.index.json';

type AssetIndex = {
	archive: string;
	blockSize: number;
	entries: TarGzIndexEntry[];
};

type BgzfTrimRange = {
	aStart: number;
	aFirstEnd: number;
	aFinalStart: number;
	aEnd: number;
	rStartOffset: number;
	rEndOffset: number;
};

type EntryResponseMode = 'stream' | 'buffered' | 'fixed';

type BgzfBody = {
	body: ReadableStream<Uint8Array<ArrayBuffer>>;
	contentLength: number;
};

function assetUrl(request: Request, path: string): URL {
	const url = new URL(request.url);
	url.pathname = path;
	url.search = '';
	return url;
}

async function fetchAsset(env: Env, request: Request, path: string, init?: RequestInit): Promise<Response> {
	return env.ASSETS.fetch(new Request(assetUrl(request, path), init));
}

async function loadIndex(env: Env, request: Request): Promise<AssetIndex> {
	const response = await fetchAsset(env, request, indexPath);
	if (!response.ok) throw new Error(`Failed to load ${indexPath}: ${response.status}`);
	return response.json();
}

async function loadArchiveBytes(env: Env, request: Request): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetchAsset(env, request, archivePath);
	if (!response.ok) throw new Error(`Failed to fetch ${archivePath}: ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

function createArchiveRangeResponse(archive: Uint8Array<ArrayBuffer>, start: number, endExclusive: number): Response {
	const chunkSize = 64 * 1024;
	let offset = start;
	return new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
		pull(controller) {
			if (offset >= endExclusive) {
				controller.close();
				return;
			}
			const next = Math.min(offset + chunkSize, endExclusive);
			controller.enqueue(archive.slice(offset, next));
			offset = next;
		},
	}), {
		status: 206,
		headers: {
			'Content-Length': String(endExclusive - start),
			'Content-Range': `bytes ${start}-${endExclusive - 1}/${archive.byteLength}`,
		},
	});
}

async function pipeBody(
	body: ReadableStream<Uint8Array> | null,
	controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
	if (body === null) return;
	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			controller.enqueue(value);
		}
	} finally {
		reader.releaseLock();
	}
}

async function readStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
	const reader = stream.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function attachment(filename: string): string {
	return `attachment; filename="${filename.replaceAll('"', '')}"`;
}

async function createTrimmedBgzfStream(
	archive: Uint8Array<ArrayBuffer>,
	range: BgzfTrimRange,
	extraBlocks: Uint8Array<ArrayBuffer>[] = [],
): Promise<BgzfBody> {
	const isSingleBlock = range.aStart === range.aFinalStart;
	const firstCompressed = archive.slice(range.aStart, range.aFirstEnd);
	const firstDecompressed = await decompressGzipChunk(firstCompressed);
	const firstTrimmed = isSingleBlock
		? firstDecompressed.slice(range.rStartOffset, firstDecompressed.length - range.rEndOffset)
		: firstDecompressed.slice(range.rStartOffset);
	const firstBgzfBlock = await createBgzfBlock(firstTrimmed);

	const intermediate = !isSingleBlock && range.aFirstEnd < range.aFinalStart
		? createArchiveRangeResponse(archive, range.aFirstEnd, range.aFinalStart)
		: null;
	const intermediateLength = intermediate === null ? 0 : range.aFinalStart - range.aFirstEnd;

	let lastBgzfBlock: Uint8Array<ArrayBuffer> | null = null;
	if (!isSingleBlock && range.aFinalStart < range.aEnd) {
		const lastCompressed = archive.slice(range.aFinalStart, range.aEnd);
		const lastDecompressed = await decompressGzipChunk(lastCompressed);
		lastBgzfBlock = await createBgzfBlock(lastDecompressed.slice(0, lastDecompressed.length - range.rEndOffset));
	}
	const extraBlocksLength = extraBlocks.reduce((sum, block) => sum + block.byteLength, 0);
	const contentLength = firstBgzfBlock.byteLength
		+ intermediateLength
		+ (lastBgzfBlock?.byteLength ?? 0)
		+ extraBlocksLength;

	const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
		async start(controller) {
			try {
				controller.enqueue(firstBgzfBlock);
				await pipeBody(intermediate?.body ?? null, controller);
				if (lastBgzfBlock !== null) controller.enqueue(lastBgzfBlock);
				for (const block of extraBlocks) controller.enqueue(block);
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
	return { body, contentLength };
}

async function materializeStreamIfBuffered(
	bgzfBody: BgzfBody,
	mode: EntryResponseMode,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer>> {
	return mode === 'buffered' ? readStream(bgzfBody.body) : bgzfBody.body;
}

function createFixedLengthBody(bgzfBody: BgzfBody): ReadableStream<Uint8Array<ArrayBuffer>> {
	const fixed = new FixedLengthStream(bgzfBody.contentLength);
	void bgzfBody.body.pipeTo(fixed.writable).catch((error: unknown) => {
		console.error('FixedLengthStream pipe failed:', error);
	});
	return fixed.readable as ReadableStream<Uint8Array<ArrayBuffer>>;
}

function modeBody(
	bgzfBody: BgzfBody,
	mode: EntryResponseMode,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>> | Uint8Array<ArrayBuffer>> {
	if (mode === 'fixed') return Promise.resolve(createFixedLengthBody(bgzfBody));
	return materializeStreamIfBuffered(bgzfBody, mode);
}

function modeName(base: string, mode: EntryResponseMode): string {
	if (mode === 'stream') return base;
	return `${base}-${mode}`;
}

async function createEntryResponse(env: Env, request: Request, entry: TarGzIndexEntry, mode: EntryResponseMode): Promise<Response> {
	const archive = await loadArchiveBytes(env, request);
	const bgzfBody = await createTrimmedBgzfStream(archive, {
		aStart: entry.aStart,
		aFirstEnd: entry.aFirstEnd,
		aFinalStart: entry.aFinalStart,
		aEnd: entry.aEnd,
		rStartOffset: entry.rStartOffset,
		rEndOffset: entry.rEndOffset,
	});
	const body = await modeBody(bgzfBody, mode);

	return new Response(body, {
		headers: {
			'Content-Type': entry.mimeType,
			'Content-Disposition': attachment(entry.path),
			'Content-Encoding': 'gzip',
			'Content-Length': String(bgzfBody.contentLength),
			'X-Repro-Mode': modeName('entry-rebgzf', mode),
			'X-Source-Ranges': `${entry.aStart}-${entry.aFirstEnd},${entry.aFirstEnd}-${entry.aFinalStart},${entry.aFinalStart}-${entry.aEnd}`,
		},
		encodeBody: 'manual',
	} as ResponseInit & { encodeBody: 'manual' });
}

async function createEntryTarGzResponse(env: Env, request: Request, entry: TarGzIndexEntry, mode: EntryResponseMode): Promise<Response> {
	const archive = await loadArchiveBytes(env, request);
	const tarEofBlock = await createBgzfBlock(new Uint8Array(1024));
	const bgzfEofBlock = await createBgzfBlock(new Uint8Array(0));
	const bgzfBody = await createTrimmedBgzfStream(archive, {
		aStart: entry.tarAStart,
		aFirstEnd: entry.tarAFirstEnd,
		aFinalStart: entry.tarAFinalStart,
		aEnd: entry.tarAEnd,
		rStartOffset: entry.tarStartOffset,
		rEndOffset: entry.tarEndOffset,
	}, [tarEofBlock, bgzfEofBlock]);
	const body = await modeBody(bgzfBody, mode);

	return new Response(body, {
		headers: {
			'Content-Type': entry.mimeType,
			'Content-Disposition': attachment(`${entry.path}.tar`),
			'Content-Encoding': 'gzip',
			'Content-Length': String(bgzfBody.contentLength),
			'X-Repro-Mode': modeName('entry-tar-gz', mode),
			'X-Source-Ranges': `${entry.tarAStart}-${entry.tarAFirstEnd},${entry.tarAFirstEnd}-${entry.tarAFinalStart},${entry.tarAFinalStart}-${entry.tarAEnd}`,
		},
		encodeBody: 'manual',
	} as ResponseInit & { encodeBody: 'manual' });
}

async function createTarResponse(env: Env, request: Request): Promise<Response> {
	const response = await fetchAsset(env, request, archivePath);
	const headers = new Headers(response.headers);
	headers.set('Content-Type', 'application/gzip');
	headers.set('Content-Disposition', attachment('photos.tar.gz'));
	headers.set('X-Repro-Mode', 'tar-gz-as-is');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		encodeBody: 'manual',
	} as ResponseInit & { encodeBody: 'manual' });
}

async function createIndexResponse(env: Env, request: Request): Promise<Response> {
	const index = await loadIndex(env, request);
	return Response.json({
		routes: {
			tar: '/tar.gz',
			entries: index.entries.map((entry) => `/entry/${encodeURIComponent(entry.path)}`),
			fixedEntries: index.entries.map((entry) => `/entry-fixed/${encodeURIComponent(entry.path)}`),
			bufferedEntries: index.entries.map((entry) => `/entry-buffered/${encodeURIComponent(entry.path)}`),
			entryTarGz: index.entries.map((entry) => `/entry-tar/${encodeURIComponent(entry.path)}`),
			fixedEntryTarGz: index.entries.map((entry) => `/entry-tar-fixed/${encodeURIComponent(entry.path)}`),
			bufferedEntryTarGz: index.entries.map((entry) => `/entry-tar-buffered/${encodeURIComponent(entry.path)}`),
		},
		index,
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === '/' || url.pathname === '/index.json') {
				return createIndexResponse(env, request);
			}

			if (url.pathname === '/tar.gz') {
				return createTarResponse(env, request);
			}

			const fixedEntryTarMatch = /^\/entry-tar-fixed\/(.+)$/.exec(url.pathname);
			if (fixedEntryTarMatch !== null) {
				const requestedPath = decodeURIComponent(fixedEntryTarMatch[1]);
				const index = await loadIndex(env, request);
				const entry = index.entries.find((item) => item.path === requestedPath);
				if (entry === undefined) return new Response('entry not found\n', { status: 404 });
				return createEntryTarGzResponse(env, request, entry, 'fixed');
			}

			const bufferedEntryTarMatch = /^\/entry-tar-buffered\/(.+)$/.exec(url.pathname);
			if (bufferedEntryTarMatch !== null) {
				const requestedPath = decodeURIComponent(bufferedEntryTarMatch[1]);
				const index = await loadIndex(env, request);
				const entry = index.entries.find((item) => item.path === requestedPath);
				if (entry === undefined) return new Response('entry not found\n', { status: 404 });
				return createEntryTarGzResponse(env, request, entry, 'buffered');
			}

			const entryTarMatch = /^\/entry-tar\/(.+)$/.exec(url.pathname);
			if (entryTarMatch !== null) {
				const requestedPath = decodeURIComponent(entryTarMatch[1]);
				const index = await loadIndex(env, request);
				const entry = index.entries.find((item) => item.path === requestedPath);
				if (entry === undefined) return new Response('entry not found\n', { status: 404 });
				return createEntryTarGzResponse(env, request, entry, 'stream');
			}

			const fixedEntryMatch = /^\/entry-fixed\/(.+)$/.exec(url.pathname);
			if (fixedEntryMatch !== null) {
				const requestedPath = decodeURIComponent(fixedEntryMatch[1]);
				const index = await loadIndex(env, request);
				const entry = index.entries.find((item) => item.path === requestedPath);
				if (entry === undefined) return new Response('entry not found\n', { status: 404 });
				return createEntryResponse(env, request, entry, 'fixed');
			}

			const bufferedEntryMatch = /^\/entry-buffered\/(.+)$/.exec(url.pathname);
			if (bufferedEntryMatch !== null) {
				const requestedPath = decodeURIComponent(bufferedEntryMatch[1]);
				const index = await loadIndex(env, request);
				const entry = index.entries.find((item) => item.path === requestedPath);
				if (entry === undefined) return new Response('entry not found\n', { status: 404 });
				return createEntryResponse(env, request, entry, 'buffered');
			}

			const entryMatch = /^\/entry\/(.+)$/.exec(url.pathname);
			if (entryMatch !== null) {
				const requestedPath = decodeURIComponent(entryMatch[1]);
				const index = await loadIndex(env, request);
				const entry = index.entries.find((item) => item.path === requestedPath);
				if (entry === undefined) return new Response('entry not found\n', { status: 404 });
				return createEntryResponse(env, request, entry, 'stream');
			}

			return new Response('not found\n', { status: 404 });
		} catch (error) {
			console.error(error);
			return new Response(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, {
				status: 500,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			});
		}
	},
} satisfies ExportedHandler<Env>;
