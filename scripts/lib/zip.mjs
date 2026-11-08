/**
 * Minimal, deterministic ZIP writer.
 *
 * Stream Deck profiles are ZIP archives. Writing them here — stored, never
 * deflated, with a fixed timestamp — keeps the generated files byte-identical
 * between builds, so a regenerated profile produces no spurious diff.
 */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c;
	}
	return table;
})();

function crc32(buffer) {
	let crc = -1;
	for (const byte of buffer) {
		crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
	}
	return (crc ^ -1) >>> 0;
}

/** 1980-01-01, the earliest timestamp the ZIP format can express. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * Builds a ZIP archive.
 * @param entries Files and directories; a directory has a trailing `/` and no data.
 * @returns The archive.
 */
export function makeZip(entries) {
	const locals = [];
	const central = [];
	let offset = 0;

	for (const { path, data } of entries) {
		const isDirectory = path.endsWith("/");
		const name = Buffer.from(path, "utf8");
		const body = isDirectory ? Buffer.alloc(0) : Buffer.from(data);
		const crc = crc32(body);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(0, 8); // stored
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);

		locals.push(local, name, body);

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4); // version made by
		header.writeUInt16LE(20, 6); // version needed
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(0, 10);
		header.writeUInt16LE(DOS_TIME, 12);
		header.writeUInt16LE(DOS_DATE, 14);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(body.length, 20);
		header.writeUInt32LE(body.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt16LE(0, 30); // extra
		header.writeUInt16LE(0, 32); // comment
		header.writeUInt16LE(0, 34); // disk
		header.writeUInt16LE(0, 36); // internal attrs
		header.writeUInt32LE(isDirectory ? 0x41ff0010 : 0x81b40000, 38); // external attrs
		header.writeUInt32LE(offset, 42);

		central.push(header, name);
		offset += local.length + name.length + body.length;
	}

	const centralBuffer = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralBuffer, end]);
}
