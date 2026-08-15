/* eslint-disable no-undef */
// zotero-TOC — lecture et réécriture d'archives ZIP (un EPUB en est une).
//
// Principe de sûreté : les entrées qu'on ne modifie PAS sont recopiées telles
// quelles, octets compressés compris. On n'a donc jamais besoin de compresser
// quoi que ce soit — les entrées modifiées ou ajoutées sont écrites « stockées »
// (sans compression), ce qui est parfaitement légal. Cela évite d'embarquer un
// compresseur, et garantit qu'un chapitre auquel on ne touche pas ressort
// rigoureusement identique.
//
// La décompression, elle, est fournie par lib/pdf-lib.js (ZTOC_PDF.inflate),
// déjà écrite en JavaScript pur.

var ZTOC_ZIP = (function () {
	"use strict";

	const SIG_LOCAL = 0x04034b50;
	const SIG_CENTRAL = 0x02014b50;
	const SIG_EOCD = 0x06054b50;

	// ---- CRC-32, exigé par l'en-tête de chaque entrée ----

	let CRC_TABLE = null;
	function crcTable() {
		if (CRC_TABLE) return CRC_TABLE;
		CRC_TABLE = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
			CRC_TABLE[n] = c;
		}
		return CRC_TABLE;
	}

	function crc32(bytes) {
		let t = crcTable();
		let c = 0xffffffff;
		for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	}

	// ---- Lecture ----

	function u16(b, p) { return b[p] | (b[p + 1] << 8); }
	function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

	function utf8Decode(bytes) {
		try { return new TextDecoder("utf-8").decode(bytes); }
		catch (e) {
			let s = "";
			for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
			return s;
		}
	}

	function utf8Encode(str) {
		try { return new TextEncoder().encode(str); }
		catch (e) {
			let out = [];
			for (let i = 0; i < str.length; i++) {
				let c = str.charCodeAt(i);
				if (c < 0x80) out.push(c);
				else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
				else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
			}
			return Uint8Array.from(out);
		}
	}

	// Rend la liste ordonnée des entrées, avec leurs octets bruts non décodés.
	function read(buf) {
		// Repérer la fin du répertoire central, en partant de la fin.
		let eocd = -1;
		let from = Math.max(0, buf.length - 66000);
		for (let i = buf.length - 22; i >= from; i--) {
			if (u32(buf, i) === SIG_EOCD) { eocd = i; break; }
		}
		if (eocd === -1) throw new Error("archive illisible : fin du répertoire introuvable");

		let count = u16(buf, eocd + 10);
		let cdOffset = u32(buf, eocd + 16);
		if (cdOffset === 0xffffffff || count === 0xffff) {
			throw new Error("archive ZIP64 non gérée");
		}

		let entries = [];
		let p = cdOffset;
		for (let i = 0; i < count; i++) {
			if (u32(buf, p) !== SIG_CENTRAL) break;
			let flags = u16(buf, p + 8);
			let method = u16(buf, p + 10);
			let crc = u32(buf, p + 16);
			let compSize = u32(buf, p + 20);
			let uncompSize = u32(buf, p + 24);
			let nameLen = u16(buf, p + 28);
			let extraLen = u16(buf, p + 30);
			let commentLen = u16(buf, p + 32);
			let localOffset = u32(buf, p + 42);
			let nameBytes = buf.subarray(p + 46, p + 46 + nameLen);

			// Les tailles réelles sont celles du répertoire central : l'en-tête
			// local peut les annoncer à zéro lorsqu'un descripteur les suit.
			let lp = localOffset;
			if (u32(buf, lp) !== SIG_LOCAL) throw new Error("en-tête local absent");
			let lNameLen = u16(buf, lp + 26);
			let lExtraLen = u16(buf, lp + 28);
			let dataStart = lp + 30 + lNameLen + lExtraLen;

			entries.push({
				name: utf8Decode(nameBytes),
				nameBytes: nameBytes,
				method: method,
				flags: flags,
				crc: crc,
				compSize: compSize,
				uncompSize: uncompSize,
				raw: buf.subarray(dataStart, dataStart + compSize),
				modified: false
			});
			p += 46 + nameLen + extraLen + commentLen;
		}
		if (!entries.length) throw new Error("archive vide");
		return entries;
	}

	// Contenu décompressé d'une entrée. `inflate` est injecté (ZTOC_PDF.inflate).
	async function readEntry(entry, inflate) {
		if (entry.data) return entry.data;
		if (entry.method === 0) return entry.raw;
		if (entry.method === 8) return await inflate(entry.raw);
		throw new Error("méthode de compression non gérée : " + entry.method);
	}

	// Remplace (ou ajoute) une entrée. Elle sera écrite sans compression.
	function setEntry(entries, name, bytes) {
		let e = entries.find(x => x.name === name);
		if (e) {
			e.data = bytes;
			e.modified = true;
			return e;
		}
		e = {
			name: name,
			nameBytes: utf8Encode(name),
			method: 0,
			flags: 0,
			data: bytes,
			modified: true
		};
		entries.push(e);
		return e;
	}

	// ---- Écriture ----

	function concat(chunks) {
		let total = 0;
		for (let c of chunks) total += c.length;
		let out = new Uint8Array(total), p = 0;
		for (let c of chunks) { out.set(c, p); p += c.length; }
		return out;
	}

	function put32(arr, p, v) {
		arr[p] = v & 0xff; arr[p + 1] = (v >>> 8) & 0xff;
		arr[p + 2] = (v >>> 16) & 0xff; arr[p + 3] = (v >>> 24) & 0xff;
	}
	function put16(arr, p, v) { arr[p] = v & 0xff; arr[p + 1] = (v >>> 8) & 0xff; }

	function write(entries) {
		let chunks = [];
		let offset = 0;
		let central = [];

		for (let e of entries) {
			let method, crc, compSize, uncompSize, payload;
			if (e.modified) {
				method = 0;
				payload = e.data;
				crc = crc32(payload);
				compSize = payload.length;
				uncompSize = payload.length;
			}
			else {
				method = e.method;
				payload = e.raw;
				crc = e.crc;
				compSize = e.compSize;
				uncompSize = e.uncompSize;
			}
			// On écrit nos propres en-têtes locaux, tailles comprises : le drapeau
			// de descripteur différé (bit 3) doit donc être retiré.
			let flags = (e.flags || 0) & ~0x08;

			let local = new Uint8Array(30 + e.nameBytes.length);
			put32(local, 0, SIG_LOCAL);
			put16(local, 4, 20);              // version minimale
			put16(local, 6, flags);
			put16(local, 8, method);
			put16(local, 10, 0);              // heure
			put16(local, 12, 0);              // date
			put32(local, 14, crc);
			put32(local, 18, compSize);
			put32(local, 22, uncompSize);
			put16(local, 26, e.nameBytes.length);
			put16(local, 28, 0);              // pas de champ supplémentaire
			local.set(e.nameBytes, 30);

			central.push({
				name: e.nameBytes, flags: flags, method: method, crc: crc,
				compSize: compSize, uncompSize: uncompSize, offset: offset
			});

			chunks.push(local);
			chunks.push(payload);
			offset += local.length + payload.length;
		}

		let cdStart = offset;
		for (let c of central) {
			let rec = new Uint8Array(46 + c.name.length);
			put32(rec, 0, SIG_CENTRAL);
			put16(rec, 4, 20);                // version d'écriture
			put16(rec, 6, 20);                // version minimale
			put16(rec, 8, c.flags);
			put16(rec, 10, c.method);
			put16(rec, 12, 0);
			put16(rec, 14, 0);
			put32(rec, 16, c.crc);
			put32(rec, 20, c.compSize);
			put32(rec, 24, c.uncompSize);
			put16(rec, 28, c.name.length);
			put16(rec, 30, 0);                // extra
			put16(rec, 32, 0);                // commentaire
			put16(rec, 34, 0);                // disque
			put16(rec, 36, 0);                // attributs internes
			put32(rec, 38, 0);                // attributs externes
			put32(rec, 42, c.offset);
			rec.set(c.name, 46);
			chunks.push(rec);
			offset += rec.length;
		}

		let eocd = new Uint8Array(22);
		put32(eocd, 0, SIG_EOCD);
		put16(eocd, 4, 0);
		put16(eocd, 6, 0);
		put16(eocd, 8, central.length);
		put16(eocd, 10, central.length);
		put32(eocd, 12, offset - cdStart);
		put32(eocd, 16, cdStart);
		put16(eocd, 20, 0);
		chunks.push(eocd);

		return concat(chunks);
	}

	return {
		read: read,
		write: write,
		readEntry: readEntry,
		setEntry: setEntry,
		crc32: crc32,
		utf8Decode: utf8Decode,
		utf8Encode: utf8Encode
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_ZIP;
