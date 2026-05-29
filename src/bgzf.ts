async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
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

export async function decompressGzipChunk(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const decompressor = new DecompressionStream('gzip');
	const writer = decompressor.writable.getWriter();
	const write = (async () => {
		await writer.write(data);
		await writer.close();
	})();
	const read = collect(decompressor.readable);
	const [, bytes] = await Promise.all([write, read]);
	return bytes;
}

async function compressDeflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const compressor = new CompressionStream('deflate-raw');
	const writer = compressor.writable.getWriter();
	const write = (async () => {
		await writer.write(data);
		await writer.close();
	})();
	const read = collect(compressor.readable);
	const [, bytes] = await Promise.all([write, read]);
	return bytes;
}

function calculateCrc32(data: Uint8Array): number {
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

function storeDeflateRaw(data: Uint8Array): Uint8Array<ArrayBuffer> {
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

export async function createBgzfBlock(uncompressed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	let deflated = await compressDeflateRaw(uncompressed);
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
	const crc = calculateCrc32(uncompressed);
	block[offset++] = crc & 0xff; block[offset++] = (crc >> 8) & 0xff;
	block[offset++] = (crc >> 16) & 0xff; block[offset++] = (crc >> 24) & 0xff;
	const isize = uncompressed.length;
	block[offset++] = isize & 0xff; block[offset++] = (isize >> 8) & 0xff;
	block[offset++] = (isize >> 16) & 0xff; block[offset++] = (isize >> 24) & 0xff;
	return block;
}
