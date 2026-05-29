import { deflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const root = new URL('..', import.meta.url);
const sourceFiles = ['P2180294.jpg', 'P2180334.jpg'];
const outDir = new URL('../dist/public/', import.meta.url);
const archiveName = 'photos.tar.gz';
const indexName = 'photos.index.json';
const blockSize = 65_000;

function crc32(data) {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	let crc = 0xffffffff;
	for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function storeDeflateRaw(data) {
	const out = new Uint8Array(5 + data.length);
	out[0] = 0x01;
	out[1] = data.length & 0xff;
	out[2] = (data.length >> 8) & 0xff;
	const nlen = (~data.length) & 0xffff;
	out[3] = nlen & 0xff;
	out[4] = (nlen >> 8) & 0xff;
	out.set(data, 5);
	return out;
}

function createBgzfBlock(uncompressed) {
	let deflated = deflateRawSync(uncompressed);
	if (deflated.length + 26 > 65536) deflated = storeDeflateRaw(uncompressed);

	const blockSize = 26 + deflated.length;
	if (blockSize > 65536) throw new Error(`BGZF block size ${blockSize} exceeds 65536 bytes.`);

	const block = new Uint8Array(blockSize);
	let offset = 0;
	block[offset++] = 0x1f; block[offset++] = 0x8b; block[offset++] = 0x08; block[offset++] = 0x04;
	block[offset++] = 0; block[offset++] = 0; block[offset++] = 0; block[offset++] = 0;
	block[offset++] = 0; block[offset++] = 0xff;
	block[offset++] = 6; block[offset++] = 0;
	block[offset++] = 0x42; block[offset++] = 0x43; block[offset++] = 0x02; block[offset++] = 0x00;
	const bsize = blockSize - 1;
	block[offset++] = bsize & 0xff; block[offset++] = (bsize >> 8) & 0xff;
	block.set(deflated, offset); offset += deflated.length;
	const crc = crc32(uncompressed);
	block[offset++] = crc & 0xff; block[offset++] = (crc >> 8) & 0xff;
	block[offset++] = (crc >> 16) & 0xff; block[offset++] = (crc >> 24) & 0xff;
	const isize = uncompressed.length;
	block[offset++] = isize & 0xff; block[offset++] = (isize >> 8) & 0xff;
	block[offset++] = (isize >> 16) & 0xff; block[offset++] = (isize >> 24) & 0xff;
	return block;
}

function writeOctal(target, offset, length, value) {
	const text = value.toString(8).padStart(length - 1, '0') + '\0';
	for (let i = 0; i < length; i++) target[offset + i] = text.charCodeAt(i);
}

function createTarHeader(name, size, mtime) {
	const header = new Uint8Array(512);
	const enc = new TextEncoder();
	header.set(enc.encode(name).slice(0, 100), 0);
	writeOctal(header, 100, 8, 0o644);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, Math.floor(mtime / 1000));
	for (let i = 148; i < 156; i++) header[i] = 0x20;
	header[156] = '0'.charCodeAt(0);
	header.set(enc.encode('ustar\0'), 257);
	header.set(enc.encode('00'), 263);
	let sum = 0;
	for (const byte of header) sum += byte;
	writeOctal(header, 148, 8, sum);
	header[155] = 0x20;
	return header;
}

async function main() {
	const chunks = [];
	const entries = [];
	let totalSize = 0;

	for (const file of sourceFiles) {
		const data = new Uint8Array(await readFile(new URL(`../${file}`, import.meta.url)));
		const name = basename(file);
		const padLen = (512 - (data.length % 512)) % 512;
		chunks.push(createTarHeader(name, data.length, Date.now()), data);
		if (padLen > 0) chunks.push(new Uint8Array(padLen));
		entries.push({
			path: name,
			mimeType: 'image/jpeg',
			size: data.length,
			tarStart: totalSize,
			tarEnd: totalSize + 512 + data.length + padLen,
			start: totalSize + 512,
			end: totalSize + 512 + data.length,
		});
		totalSize += 512 + data.length + padLen;
	}
	chunks.push(new Uint8Array(1024));
	totalSize += 1024;

	const tar = new Uint8Array(totalSize);
	let tarOffset = 0;
	for (const chunk of chunks) {
		tar.set(chunk, tarOffset);
		tarOffset += chunk.length;
	}

	const blocks = [];
	const blockOffsets = [];
	const blockLengths = [];
	let compressedOffset = 0;
	for (let offset = 0; offset < tar.length; offset += blockSize) {
		const block = createBgzfBlock(tar.slice(offset, Math.min(offset + blockSize, tar.length)));
		blocks.push(block);
		blockOffsets.push(compressedOffset);
		blockLengths.push(block.length);
		compressedOffset += block.length;
	}
	const eofBlock = createBgzfBlock(new Uint8Array(0));
	blocks.push(eofBlock);
	blockOffsets.push(compressedOffset);
	blockLengths.push(eofBlock.length);

	const archive = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
	let archiveOffset = 0;
	for (const block of blocks) {
		archive.set(block, archiveOffset);
		archiveOffset += block.length;
	}

	function createRangeIndex(start, end) {
		const si = Math.floor(start / blockSize);
		const ei = Math.floor(Math.max(end - 1, start) / blockSize);
		return {
			aStart: blockOffsets[si],
			aFirstEnd: blockOffsets[si] + blockLengths[si],
			aFinalStart: blockOffsets[ei],
			aEnd: blockOffsets[ei] + blockLengths[ei],
			rStartOffset: start - si * blockSize,
			rEndOffset: Math.min((ei + 1) * blockSize, tar.length) - end,
		};
	}

	const index = entries.map((entry) => {
		const fileRange = createRangeIndex(entry.start, entry.end);
		const tarRange = createRangeIndex(entry.tarStart, entry.tarEnd);
		return {
			path: entry.path,
			mimeType: entry.mimeType,
			size: entry.size,
			...fileRange,
			tarAStart: tarRange.aStart,
			tarAFirstEnd: tarRange.aFirstEnd,
			tarAFinalStart: tarRange.aFinalStart,
			tarAEnd: tarRange.aEnd,
			tarStartOffset: tarRange.rStartOffset,
			tarEndOffset: tarRange.rEndOffset,
		};
	});

	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir.pathname, archiveName), archive);
	await writeFile(join(outDir.pathname, indexName), JSON.stringify({ archive: archiveName, blockSize, entries: index }, null, 2));
	console.log(`wrote ${archiveName} (${archive.length} bytes) and ${indexName} from ${sourceFiles.join(', ')}`);
}

await main();
