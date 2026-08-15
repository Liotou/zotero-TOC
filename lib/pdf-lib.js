/* eslint-disable no-undef */
// zotero-TOC — moteur PDF autonome (lecture de structure + écriture de sommaire)
//
// Aucune dépendance : ce fichier tourne tel quel dans le contexte privilégié de
// Zotero (chargé par loadSubScript) comme dans Node (harnais de test).
//
// Deux responsabilités :
//   1. Relire assez de la structure d'un PDF pour retrouver le catalogue et la
//      liste ordonnée des références d'objet des pages.
//   2. Réécrire le fichier en lui ajoutant un /Outlines, par MISE À JOUR
//      INCRÉMENTALE : les octets d'origine ne sont jamais touchés, tout est
//      ajouté à la fin. C'est ce qui garantit qu'un PDF signé, annoté ou
//      exotique ne peut pas être corrompu par le plugin — au pire l'ajout est
//      ignoré par le lecteur.

var ZTOC_PDF = (function () {
	"use strict";

	// ---- Primitives ----

	function Name(n) { return { _name: n }; }
	function isName(o, n) { return o && o._name !== undefined && (n === undefined || o._name === n); }
	function Ref(num, gen) { return { _ref: true, num: num, gen: gen }; }
	function isRef(o) { return o && o._ref === true; }

	const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
	const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

	function isWS(c) { return WS.has(c); }
	function isDelim(c) { return DELIM.has(c); }
	function isRegular(c) { return !isWS(c) && !isDelim(c); }

	// ---- Lecteur d'octets ----

	// Analyseur syntaxique minimal mais complet des objets PDF. Il travaille
	// directement sur l'Uint8Array pour pouvoir rendre les PLAGES d'octets : on
	// recopie ensuite le dictionnaire du catalogue à l'identique plutôt que de le
	// re-sérialiser, ce qui éliminerait le risque d'en perdre une subtilité.
	function Lexer(buf) {
		this.buf = buf;
		this.pos = 0;
	}

	Lexer.prototype.skipWS = function () {
		let b = this.buf;
		while (this.pos < b.length) {
			let c = b[this.pos];
			if (isWS(c)) { this.pos++; continue; }
			// Commentaire : jusqu'à la fin de ligne.
			if (c === 0x25) {
				while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
				continue;
			}
			break;
		}
	};

	Lexer.prototype.readToken = function () {
		this.skipWS();
		let b = this.buf;
		if (this.pos >= b.length) return null;
		let start = this.pos;
		let c = b[this.pos];
		if (!isRegular(c)) { this.pos++; return String.fromCharCode(c); }
		while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
		return latin1(b, start, this.pos);
	};

	Lexer.prototype.peekByte = function () {
		this.skipWS();
		return this.pos < this.buf.length ? this.buf[this.pos] : -1;
	};

	function latin1(buf, start, end) {
		let s = "";
		for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
		return s;
	}

	// Nom PDF, avec décodage des échappements #xx.
	Lexer.prototype.readName = function () {
		this.pos++; // '/'
		let b = this.buf, s = "";
		while (this.pos < b.length && isRegular(b[this.pos])) {
			let c = b[this.pos];
			if (c === 0x23 && this.pos + 2 < b.length) {
				let hex = latin1(b, this.pos + 1, this.pos + 3);
				let v = parseInt(hex, 16);
				if (!isNaN(v)) { s += String.fromCharCode(v); this.pos += 3; continue; }
			}
			s += String.fromCharCode(c);
			this.pos++;
		}
		return Name(s);
	};

	// Chaîne littérale ( ... ) : parenthèses imbriquées et échappements.
	Lexer.prototype.readString = function () {
		let b = this.buf;
		this.pos++; // '('
		let depth = 1, out = [];
		while (this.pos < b.length) {
			let c = b[this.pos++];
			if (c === 0x5c) { // backslash
				let d = b[this.pos++];
				switch (d) {
					case 0x6e: out.push(0x0a); break;
					case 0x72: out.push(0x0d); break;
					case 0x74: out.push(0x09); break;
					case 0x62: out.push(0x08); break;
					case 0x66: out.push(0x0c); break;
					case 0x0a: break;
					case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break;
					default:
						if (d >= 0x30 && d <= 0x37) {
							let oct = d - 0x30;
							for (let k = 0; k < 2; k++) {
								let e = b[this.pos];
								if (e >= 0x30 && e <= 0x37) { oct = oct * 8 + (e - 0x30); this.pos++; }
								else break;
							}
							out.push(oct & 0xff);
						}
						else out.push(d);
				}
				continue;
			}
			if (c === 0x28) { depth++; out.push(c); continue; }
			if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); continue; }
			out.push(c);
		}
		return { _str: Uint8Array.from(out) };
	};

	// Chaîne hexadécimale < ... >
	Lexer.prototype.readHexString = function () {
		let b = this.buf;
		this.pos++; // '<'
		let digits = "";
		while (this.pos < b.length && b[this.pos] !== 0x3e) {
			let ch = String.fromCharCode(b[this.pos]);
			if (/[0-9a-fA-F]/.test(ch)) digits += ch;
			this.pos++;
		}
		this.pos++; // '>'
		if (digits.length & 1) digits += "0";
		let out = new Uint8Array(digits.length / 2);
		for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
		return { _str: out };
	};

	// Objet quelconque. `xref` est optionnel : il ne sert qu'à résoudre un
	// /Length indirect au moment de délimiter un flux.
	Lexer.prototype.parseObject = function (xref) {
		this.skipWS();
		let b = this.buf;
		if (this.pos >= b.length) return null;
		let c = b[this.pos];

		if (c === 0x2f) return this.readName();
		if (c === 0x28) return this.readString();
		if (c === 0x5b) { // '['
			this.pos++;
			let arr = [];
			for (;;) {
				this.skipWS();
				if (this.pos >= b.length) break;
				if (b[this.pos] === 0x5d) { this.pos++; break; }
				let before = this.pos;
				arr.push(this.parseObject(xref));
				if (this.pos === before) { this.pos++; } // sécurité anti-boucle
			}
			return arr;
		}
		if (c === 0x3c) {
			if (b[this.pos + 1] === 0x3c) return this.parseDict(xref);
			return this.readHexString();
		}
		if (c === 0x3e || c === 0x5d || c === 0x29) { this.pos++; return null; }

		// Nombre, référence indirecte, ou mot-clé.
		let save = this.pos;
		let tok = this.readToken();
		if (tok === null) return null;

		if (/^[+-]?[\d.]+$/.test(tok)) {
			// Une référence « N G R » ne se distingue d'un nombre qu'en regardant
			// deux jetons plus loin ; on revient en arrière si ce n'en est pas une.
			if (/^\d+$/.test(tok)) {
				let after = this.pos;
				let t2 = this.readToken();
				if (t2 !== null && /^\d+$/.test(t2)) {
					let t3 = this.readToken();
					if (t3 === "R") return Ref(parseInt(tok, 10), parseInt(t2, 10));
				}
				this.pos = after;
			}
			let v = parseFloat(tok);
			return isNaN(v) ? null : v;
		}
		if (tok === "true") return true;
		if (tok === "false") return false;
		if (tok === "null") return null;

		// Mot-clé inattendu : on le rend tel quel pour que l'appelant décide.
		return { _kw: tok, _at: save };
	};

	Lexer.prototype.parseDict = function (xref) {
		let b = this.buf;
		let dictStart = this.pos;
		this.pos += 2; // '<<'
		let map = new Map();
		for (;;) {
			this.skipWS();
			if (this.pos >= b.length) break;
			if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; break; }
			if (b[this.pos] !== 0x2f) {
				// Clé illisible : on avance pour ne pas boucler.
				let before = this.pos;
				this.parseObject(xref);
				if (this.pos === before) this.pos++;
				continue;
			}
			let key = this.readName()._name;
			let val = this.parseObject(xref);
			map.set(key, val);
		}
		let dictEnd = this.pos;

		// Un flux suit-il ?
		let save = this.pos;
		this.skipWS();
		if (latin1(b, this.pos, this.pos + 6) === "stream") {
			this.pos += 6;
			if (b[this.pos] === 0x0d) this.pos++;
			if (b[this.pos] === 0x0a) this.pos++;
			let dataStart = this.pos;
			let len = map.get("Length");
			if (isRef(len) && xref) len = xref.fetchSync(len.num);
			let dataEnd;
			if (typeof len === "number" && len >= 0 && dataStart + len <= b.length) {
				dataEnd = dataStart + len;
				// /Length erroné : on vérifie qu'« endstream » suit bien.
				let probe = latin1(b, dataEnd, dataEnd + 20);
				if (!/^\s*endstream/.test(probe)) dataEnd = findEndstream(b, dataStart);
			}
			else {
				dataEnd = findEndstream(b, dataStart);
			}
			this.pos = dataEnd;
			let idx = indexOfBytes(b, "endstream", dataEnd);
			this.pos = idx === -1 ? dataEnd : idx + 9;
			return { _dict: map, _stream: { start: dataStart, end: dataEnd }, range: [dictStart, dictEnd] };
		}
		this.pos = save;
		return { _dict: map, range: [dictStart, dictEnd] };
	};

	function findEndstream(buf, from) {
		let idx = indexOfBytes(buf, "endstream", from);
		if (idx === -1) return buf.length;
		let end = idx;
		// Retirer le saut de ligne qui précède le mot-clé.
		if (end > from && buf[end - 1] === 0x0a) end--;
		if (end > from && buf[end - 1] === 0x0d) end--;
		return end;
	}

	function indexOfBytes(buf, str, from) {
		let pat = [];
		for (let i = 0; i < str.length; i++) pat.push(str.charCodeAt(i));
		outer:
		for (let i = Math.max(0, from); i <= buf.length - pat.length; i++) {
			for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
			return i;
		}
		return -1;
	}

	function lastIndexOfBytes(buf, str, from) {
		let pat = [];
		for (let i = 0; i < str.length; i++) pat.push(str.charCodeAt(i));
		outer:
		for (let i = Math.min(from, buf.length - pat.length); i >= 0; i--) {
			for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
			return i;
		}
		return -1;
	}

	function dictGet(obj, key) {
		if (!obj) return undefined;
		if (obj._dict) return obj._dict.get(key);
		if (obj instanceof Map) return obj.get(key);
		return undefined;
	}

	// ---- Décompression ----

	// FlateDecode en JavaScript pur.
	//
	// Une première version s'appuyait sur DecompressionStream, via Blob et
	// Response. Ces deux API appartiennent au DOM : elles n'existent PAS dans le
	// contexte système où s'exécute un plugin Zotero. La décompression échouait
	// donc silencieusement, et tout PDF dont la table de références est un FLUX
	// (un tiers du corpus) paraissait n'avoir aucune page. D'où cette
	// implémentation autonome, qui ne dépend de rien.

	// Lecteur de bits, poids faibles en tête, comme le veut DEFLATE.
	function BitReader(data, pos) {
		this.d = data;
		this.p = pos || 0;
		this.bit = 0;
		this.cur = 0;
	}

	BitReader.prototype.readBit = function () {
		if (this.bit === 0) {
			if (this.p >= this.d.length) throw new Error("flux compressé tronqué");
			this.cur = this.d[this.p++];
			this.bit = 8;
		}
		let b = this.cur & 1;
		this.cur >>= 1;
		this.bit--;
		return b;
	};

	BitReader.prototype.readBits = function (n) {
		let v = 0;
		for (let i = 0; i < n; i++) v |= this.readBit() << i;
		return v;
	};

	BitReader.prototype.align = function () { this.bit = 0; };

	// Table de Huffman canonique : à partir des longueurs de code, on construit
	// les bornes par longueur, ce qui permet un décodage bit à bit sans arbre.
	function buildHuffman(lengths) {
		let maxLen = 0;
		for (let l of lengths) if (l > maxLen) maxLen = l;
		let blCount = new Int32Array(maxLen + 1);
		for (let l of lengths) if (l) blCount[l]++;
		let code = 0;
		let nextCode = new Int32Array(maxLen + 2);
		for (let bits = 1; bits <= maxLen; bits++) {
			code = (code + blCount[bits - 1]) << 1;
			nextCode[bits] = code;
		}
		let counts = new Int32Array(maxLen + 1);
		let symbols = new Int32Array(lengths.length);
		let offsets = new Int32Array(maxLen + 2);
		for (let l of lengths) if (l) counts[l]++;
		let off = 0;
		for (let bits = 1; bits <= maxLen; bits++) { offsets[bits] = off; off += counts[bits]; }
		let fill = offsets.slice();
		for (let sym = 0; sym < lengths.length; sym++) {
			if (lengths[sym]) symbols[fill[lengths[sym]]++] = sym;
		}
		return { counts: counts, symbols: symbols, maxLen: maxLen };
	}

	function decodeSymbol(br, table) {
		let code = 0, first = 0, index = 0;
		for (let len = 1; len <= table.maxLen; len++) {
			code |= br.readBit();
			let count = table.counts[len];
			if (code - first < count) return table.symbols[index + (code - first)];
			index += count;
			first = (first + count) << 1;
			code <<= 1;
		}
		throw new Error("code Huffman invalide");
	}

	const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
		67, 83, 99, 115, 131, 163, 195, 227, 258];
	const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
		4, 4, 4, 4, 5, 5, 5, 5, 0];
	const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385,
		513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
	const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7,
		8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
	const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

	let FIXED_LIT = null, FIXED_DIST = null;
	function fixedTables() {
		if (FIXED_LIT) return;
		let l = new Uint8Array(288);
		for (let i = 0; i < 144; i++) l[i] = 8;
		for (let i = 144; i < 256; i++) l[i] = 9;
		for (let i = 256; i < 280; i++) l[i] = 7;
		for (let i = 280; i < 288; i++) l[i] = 8;
		FIXED_LIT = buildHuffman(l);
		let d = new Uint8Array(30);
		for (let i = 0; i < 30; i++) d[i] = 5;
		FIXED_DIST = buildHuffman(d);
	}

	function inflateRaw(data, startPos) {
		let br = new BitReader(data, startPos || 0);
		// Tampon de sortie agrandi par doublement : la taille finale est inconnue.
		let out = new Uint8Array(Math.max(1024, data.length * 4));
		let len = 0;
		let grow = (need) => {
			if (len + need <= out.length) return;
			let size = out.length;
			while (size < len + need) size *= 2;
			let bigger = new Uint8Array(size);
			bigger.set(out.subarray(0, len));
			out = bigger;
		};

		for (;;) {
			let last = br.readBit();
			let type = br.readBits(2);

			if (type === 0) {
				// Bloc non compressé.
				br.align();
				if (br.p + 4 > data.length) throw new Error("bloc stocké tronqué");
				let n = data[br.p] | (data[br.p + 1] << 8);
				br.p += 4;   // longueur puis son complément
				grow(n);
				if (br.p + n > data.length) n = Math.max(0, data.length - br.p);
				out.set(data.subarray(br.p, br.p + n), len);
				len += n;
				br.p += n;
			}
			else if (type === 1 || type === 2) {
				let lit, dist;
				if (type === 1) {
					fixedTables();
					lit = FIXED_LIT; dist = FIXED_DIST;
				}
				else {
					let hlit = br.readBits(5) + 257;
					let hdist = br.readBits(5) + 1;
					let hclen = br.readBits(4) + 4;
					let clen = new Uint8Array(19);
					for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.readBits(3);
					let clTable = buildHuffman(clen);

					let lengths = new Uint8Array(hlit + hdist);
					let i = 0;
					while (i < lengths.length) {
						let sym = decodeSymbol(br, clTable);
						if (sym < 16) { lengths[i++] = sym; continue; }
						let repeat, value = 0;
						if (sym === 16) {
							if (i === 0) throw new Error("répétition sans longueur précédente");
							value = lengths[i - 1];
							repeat = 3 + br.readBits(2);
						}
						else if (sym === 17) repeat = 3 + br.readBits(3);
						else repeat = 11 + br.readBits(7);
						while (repeat-- > 0 && i < lengths.length) lengths[i++] = value;
					}
					lit = buildHuffman(lengths.subarray(0, hlit));
					dist = buildHuffman(lengths.subarray(hlit));
				}

				for (;;) {
					let sym = decodeSymbol(br, lit);
					if (sym === 256) break;
					if (sym < 256) {
						grow(1);
						out[len++] = sym;
						continue;
					}
					let li = sym - 257;
					if (li >= LEN_BASE.length) throw new Error("code de longueur invalide");
					let length = LEN_BASE[li] + br.readBits(LEN_EXTRA[li]);
					let ds = decodeSymbol(br, dist);
					if (ds >= DIST_BASE.length) throw new Error("code de distance invalide");
					let distance = DIST_BASE[ds] + br.readBits(DIST_EXTRA[ds]);
					if (distance > len) throw new Error("distance hors du tampon");
					grow(length);
					let from = len - distance;
					// Recopie octet par octet : les plages peuvent se chevaucher.
					for (let k = 0; k < length; k++) out[len++] = out[from + k];
				}
			}
			else {
				throw new Error("type de bloc DEFLATE réservé");
			}

			if (last) break;
			if (br.p > data.length) break;
		}
		return out.subarray(0, len);
	}

	// Accepte l'enveloppe zlib comme le DEFLATE brut : certains PDF annoncent
	// FlateDecode mais omettent l'en-tête.
	async function inflate(bytes) {
		if (!bytes.length) return new Uint8Array(0);
		let hasZlibHeader = false;
		if (bytes.length >= 2) {
			let cmf = bytes[0], flg = bytes[1];
			if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) hasZlibHeader = true;
		}
		try {
			return inflateRaw(bytes, hasZlibHeader ? 2 : 0);
		}
		catch (e) {
			// Dernier recours : réessayer avec l'autre hypothèse d'en-tête.
			try { return inflateRaw(bytes, hasZlibHeader ? 0 : 2); }
			catch (e2) { throw new Error("FlateDecode a échoué : " + (e.message || e)); }
		}
	}

	// Annulation des prédicteurs (PNG surtout : les flux xref les utilisent
	// presque toujours avec /Predictor 12).
	function undoPredictor(data, params) {
		let pred = params.predictor || 1;
		if (pred <= 1) return data;
		let colors = params.colors || 1;
		let bpc = params.bpc || 8;
		let columns = params.columns || 1;
		let bpp = Math.ceil(colors * bpc / 8);
		let rowLen = Math.ceil(colors * bpc * columns / 8);

		if (pred === 2) {
			if (bpc !== 8) return data; // cas rare, non géré
			for (let r = 0; r + rowLen <= data.length; r += rowLen) {
				for (let i = bpp; i < rowLen; i++) data[r + i] = (data[r + i] + data[r + i - bpp]) & 0xff;
			}
			return data;
		}

		// PNG : chaque ligne est précédée d'un octet de filtre.
		let nRows = Math.floor(data.length / (rowLen + 1));
		let out = new Uint8Array(nRows * rowLen);
		let prev = new Uint8Array(rowLen);
		for (let r = 0; r < nRows; r++) {
			let ft = data[r * (rowLen + 1)];
			let src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
			let cur = out.subarray(r * rowLen, r * rowLen + rowLen);
			cur.set(src);
			switch (ft) {
				case 0: break;
				case 1: for (let i = bpp; i < rowLen; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff; break;
				case 2: for (let i = 0; i < rowLen; i++) cur[i] = (cur[i] + prev[i]) & 0xff; break;
				case 3:
					for (let i = 0; i < rowLen; i++) {
						let left = i >= bpp ? cur[i - bpp] : 0;
						cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
					}
					break;
				case 4:
					for (let i = 0; i < rowLen; i++) {
						let a = i >= bpp ? cur[i - bpp] : 0;
						let b2 = prev[i];
						let c2 = i >= bpp ? prev[i - bpp] : 0;
						let p = a + b2 - c2;
						let pa = Math.abs(p - a), pb = Math.abs(p - b2), pc = Math.abs(p - c2);
						let pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b2 : c2);
						cur[i] = (cur[i] + pr) & 0xff;
					}
					break;
				default: break;
			}
			prev = cur;
		}
		return out;
	}

	// ---- Table des références croisées ----

	function XRef(buf) {
		this.buf = buf;
		this.entries = new Map();   // num -> {type:1, offset} | {type:2, stm, idx}
		this.trailer = new Map();
		this.cache = new Map();
		this.objStmCache = new Map();
	}

	XRef.prototype.trailerGet = function (key) { return this.trailer.get(key); };

	// Suit la chaîne startxref → /Prev. Les entrées les plus récentes gagnent :
	// on n'écrase donc jamais une entrée déjà vue.
	XRef.prototype.parse = async function () {
		let buf = this.buf;
		let tailFrom = Math.max(0, buf.length - 2048);
		let sx = lastIndexOfBytes(buf, "startxref", buf.length);
		if (sx === -1) throw new Error("startxref introuvable");
		let lex = new Lexer(buf);
		lex.pos = sx + 9;
		let start = lex.parseObject(null);
		if (typeof start !== "number") throw new Error("startxref illisible");

		let seen = new Set();
		let queue = [start];
		while (queue.length) {
			let off = queue.shift();
			if (!Number.isFinite(off) || off < 0 || off >= buf.length || seen.has(off)) continue;
			seen.add(off);
			let tr;
			try { tr = await this.parseSection(off); }
			catch (e) { continue; }
			if (!tr) continue;
			for (let [k, v] of tr) if (!this.trailer.has(k)) this.trailer.set(k, v);
			// /XRefStm : fichier hybride, la section en flux complète la table.
			let hyb = tr.get("XRefStm");
			if (typeof hyb === "number") queue.push(hyb);
			let prev = tr.get("Prev");
			if (typeof prev === "number") queue.push(prev);
		}
		if (!this.trailer.get("Root")) {
			// Fichier abîmé : reconstruction par balayage des « N G obj ».
			this.scanAllObjects();
		}
		if (tailFrom < 0) throw new Error("fichier trop court");
		return this;
	};

	XRef.prototype.parseSection = async function (off) {
		let buf = this.buf;
		let lex = new Lexer(buf);
		lex.pos = off;
		lex.skipWS();
		if (latin1(buf, lex.pos, lex.pos + 4) === "xref") {
			lex.pos += 4;
			return this.parseTable(lex);
		}
		return this.parseStream(lex);
	};

	XRef.prototype.parseTable = function (lex) {
		let buf = this.buf;
		for (;;) {
			lex.skipWS();
			if (latin1(buf, lex.pos, lex.pos + 7) === "trailer") {
				lex.pos += 7;
				let d = lex.parseObject(null);
				return d && d._dict ? d._dict : new Map();
			}
			let first = lex.parseObject(null);
			let count = lex.parseObject(null);
			if (typeof first !== "number" || typeof count !== "number") return new Map();
			for (let i = 0; i < count; i++) {
				lex.skipWS();
				let a = lex.readToken(), b = lex.readToken(), t = lex.readToken();
				let num = first + i;
				if (t === "n" && !this.entries.has(num)) {
					this.entries.set(num, { type: 1, offset: parseInt(a, 10), gen: parseInt(b, 10) || 0 });
				}
				else if (t !== "n" && t !== "f") {
					return new Map();
				}
			}
		}
	};

	XRef.prototype.parseStream = async function (lex) {
		// « N G obj << ... >> stream »
		lex.readToken(); lex.readToken(); lex.readToken();
		let obj = lex.parseObject(null);
		if (!obj || !obj._dict || !obj._stream) throw new Error("flux xref attendu");
		let dict = obj._dict;
		let raw = this.buf.subarray(obj._stream.start, obj._stream.end);
		let data = await this.decodeStream(dict, raw);

		let w = dict.get("W") || [];
		if (!Array.isArray(w) || w.length < 3) throw new Error("/W invalide");
		let w0 = w[0] | 0, w1 = w[1] | 0, w2 = w[2] | 0;
		let size = dict.get("Size") || 0;
		let index = dict.get("Index");
		if (!Array.isArray(index)) index = [0, size];

		let p = 0;
		let readField = (n, dflt) => {
			if (n === 0) return dflt;
			let v = 0;
			for (let i = 0; i < n; i++) v = v * 256 + (data[p++] | 0);
			return v;
		};
		for (let s = 0; s + 1 < index.length; s += 2) {
			let first = index[s], count = index[s + 1];
			for (let i = 0; i < count; i++) {
				if (p >= data.length) break;
				let type = readField(w0, 1);
				let f2 = readField(w1, 0);
				let f3 = readField(w2, 0);
				let num = first + i;
				if (this.entries.has(num)) continue;
				if (type === 1) this.entries.set(num, { type: 1, offset: f2, gen: f3 });
				else if (type === 2) this.entries.set(num, { type: 2, stm: f2, idx: f3 });
			}
		}
		return dict;
	};

	XRef.prototype.decodeStream = async function (dict, raw) {
		let filter = dict.get("Filter");
		let parms = dict.get("DecodeParms") || dict.get("DP");
		if (isRef(filter)) filter = this.fetchSync(filter.num);
		let filters = [];
		if (isName(filter)) filters = [filter._name];
		else if (Array.isArray(filter)) filters = filter.map(f => (isName(f) ? f._name : ""));
		let parmList = Array.isArray(parms) ? parms : [parms];

		let data = raw;
		for (let i = 0; i < filters.length; i++) {
			let f = filters[i];
			if (f === "FlateDecode" || f === "Fl") {
				data = await inflate(data);
				let pd = parmList[i];
				let pdict = pd && pd._dict ? pd._dict : (pd instanceof Map ? pd : null);
				if (pdict) {
					data = undoPredictor(data, {
						predictor: num(pdict.get("Predictor")),
						colors: num(pdict.get("Colors")),
						bpc: num(pdict.get("BitsPerComponent")),
						columns: num(pdict.get("Columns"))
					});
				}
			}
			else if (f === "" || f === undefined) { /* rien */ }
			else {
				throw new Error("filtre non géré : " + f);
			}
		}
		return data;

		function num(v) { return typeof v === "number" ? v : undefined; }
	};

	// Balayage brut du fichier : filet de sécurité pour les xref cassées.
	XRef.prototype.scanAllObjects = function () {
		let buf = this.buf;
		let re = /(\d+)\s+(\d+)\s+obj\b/g;
		let s = latin1(buf, 0, buf.length);
		let m;
		while ((m = re.exec(s)) !== null) {
			this.entries.set(parseInt(m[1], 10), { type: 1, offset: m.index, gen: parseInt(m[2], 10) });
		}
		let t = s.lastIndexOf("trailer");
		if (t !== -1) {
			let lex = new Lexer(buf);
			lex.pos = t + 7;
			let d = lex.parseObject(null);
			if (d && d._dict) for (let [k, v] of d._dict) if (!this.trailer.has(k)) this.trailer.set(k, v);
		}
		if (!this.trailer.get("Root")) {
			// Repérer un objet /Type /Catalog.
			let ci = s.indexOf("/Type/Catalog");
			if (ci === -1) ci = s.indexOf("/Type /Catalog");
			if (ci !== -1) {
				let ob = s.lastIndexOf(" obj", ci);
				let line = s.slice(Math.max(0, ob - 20), ob);
				let mm = line.match(/(\d+)\s+(\d+)\s*$/);
				if (mm) this.trailer.set("Root", Ref(parseInt(mm[1], 10), parseInt(mm[2], 10)));
			}
		}
	};

	// Récupération d'un objet direct (hors flux d'objets) : synchrone, utilisée
	// pour résoudre un /Length indirect pendant l'analyse.
	XRef.prototype.fetchSync = function (numObj) {
		let e = this.entries.get(numObj);
		if (!e || e.type !== 1) return undefined;
		let lex = new Lexer(this.buf);
		lex.pos = e.offset;
		let a = lex.readToken(), b = lex.readToken(), kw = lex.readToken();
		if (kw !== "obj") return undefined;
		return lex.parseObject(null);
	};

	// Récupération complète, y compris depuis un flux d'objets compressé.
	XRef.prototype.fetch = async function (numObj) {
		if (this.cache.has(numObj)) return this.cache.get(numObj);
		let e = this.entries.get(numObj);
		if (!e) return undefined;
		let val;
		if (e.type === 1) {
			let lex = new Lexer(this.buf);
			lex.pos = e.offset;
			let a = lex.readToken(), b = lex.readToken(), kw = lex.readToken();
			if (kw !== "obj") { this.cache.set(numObj, undefined); return undefined; }
			if (parseInt(a, 10) !== numObj) {
				// Décalage d'offset : on laisse le balayage de secours corriger.
				this.cache.set(numObj, undefined);
				return undefined;
			}
			val = lex.parseObject(this);
		}
		else {
			let parsed = await this.getObjStm(e.stm);
			val = parsed ? parsed.get(numObj) : undefined;
		}
		this.cache.set(numObj, val);
		return val;
	};

	XRef.prototype.getObjStm = async function (stmNum) {
		if (this.objStmCache.has(stmNum)) return this.objStmCache.get(stmNum);
		let result = new Map();
		this.objStmCache.set(stmNum, result);
		let e = this.entries.get(stmNum);
		if (!e || e.type !== 1) return result;
		let lex = new Lexer(this.buf);
		lex.pos = e.offset;
		lex.readToken(); lex.readToken();
		if (lex.readToken() !== "obj") return result;
		let obj = lex.parseObject(this);
		if (!obj || !obj._dict || !obj._stream) return result;
		let raw = this.buf.subarray(obj._stream.start, obj._stream.end);
		let data;
		try { data = await this.decodeStream(obj._dict, raw); }
		catch (err) { return result; }

		let n = obj._dict.get("N") || 0;
		let first = obj._dict.get("First") || 0;
		if (isRef(n)) n = this.fetchSync(n.num);
		if (isRef(first)) first = this.fetchSync(first.num);

		let head = new Lexer(data);
		let pairs = [];
		for (let i = 0; i < n; i++) {
			let a = head.readToken(), b = head.readToken();
			pairs.push([parseInt(a, 10), parseInt(b, 10)]);
		}
		for (let [onum, ooff] of pairs) {
			if (!Number.isFinite(onum) || !Number.isFinite(ooff)) continue;
			let l2 = new Lexer(data);
			l2.pos = first + ooff;
			if (l2.pos >= data.length) continue;
			let v = l2.parseObject(null);
			// Conserver les octets d'origine du dictionnaire, pour recopie exacte.
			if (v && v.range) v._srcBuf = data;
			result.set(onum, v);
		}
		return result;
	};

	XRef.prototype.resolve = async function (v) {
		let guard = 0;
		while (isRef(v) && guard++ < 32) v = await this.fetch(v.num);
		return v;
	};

	// ---- Parcours de l'arbre des pages ----

	// Rend la liste ORDONNÉE des références d'objet des pages. Nécessaire pour
	// construire les destinations du sommaire : une destination pointe sur la
	// référence de la page, pas sur son numéro.
	XRef.prototype.getPageRefs = async function () {
		let root = await this.resolve(this.trailer.get("Root"));
		let pagesRef = dictGet(root, "Pages");
		let out = [];
		let seen = new Set();

		let walk = async (nodeRef, depth) => {
			if (depth > 64 || out.length > 20000) return;
			let key = isRef(nodeRef) ? nodeRef.num : null;
			if (key !== null) {
				if (seen.has(key)) return;
				seen.add(key);
			}
			let node = await this.resolve(nodeRef);
			if (!node) return;
			let type = dictGet(node, "Type");
			let kids = await this.resolve(dictGet(node, "Kids"));
			if (Array.isArray(kids) && !isName(type, "Page")) {
				for (let k of kids) await walk(k, depth + 1);
				return;
			}
			if (isName(type, "Page") || (!kids && dictGet(node, "Contents") !== undefined)
				|| (!kids && dictGet(node, "MediaBox") !== undefined)) {
				if (isRef(nodeRef)) out.push(nodeRef);
			}
		};

		await walk(pagesRef, 0);
		return out;
	};

	// Le catalogue possède-t-il déjà un sommaire non vide ?
	XRef.prototype.hasOutline = async function () {
		let root = await this.resolve(this.trailer.get("Root"));
		let ol = dictGet(root, "Outlines");
		if (!ol) return false;
		let olObj = await this.resolve(ol);
		if (!olObj) return false;
		let first = dictGet(olObj, "First");
		let count = dictGet(olObj, "Count");
		if (first) return true;
		return typeof count === "number" && count !== 0;
	};

	XRef.prototype.isEncrypted = function () { return !!this.trailer.get("Encrypt"); };

	// ---- Écriture ----

	function esc(str) {
		// Titre en chaîne hexadécimale UTF-16BE : aucun échappement à gérer, et
		// les accents et caractères non latins passent sans dommage.
		let out = "FEFF";
		for (let ch of String(str)) {
			let cp = ch.codePointAt(0);
			if (cp > 0xffff) {
				cp -= 0x10000;
				let hi = 0xd800 + (cp >> 10), lo = 0xdc00 + (cp & 0x3ff);
				out += hex4(hi) + hex4(lo);
			}
			else out += hex4(cp);
		}
		return "<" + out + ">";
		function hex4(n) { return n.toString(16).toUpperCase().padStart(4, "0"); }
	}

	function bytesOf(str) {
		let out = new Uint8Array(str.length);
		for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
		return out;
	}

	function concat(chunks) {
		let total = 0;
		for (let c of chunks) total += c.length;
		let out = new Uint8Array(total);
		let p = 0;
		for (let c of chunks) { out.set(c, p); p += c.length; }
		return out;
	}

	// Sérialise une valeur PDF simple (utilisé pour recopier /Info, /ID…).
	function serialize(v) {
		if (v === null || v === undefined) return "null";
		if (v === true) return "true";
		if (v === false) return "false";
		if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(6)));
		if (isRef(v)) return v.num + " " + v.gen + " R";
		if (isName(v)) return "/" + v._name.replace(/[^\x21-\x7e]|[#()<>\[\]{}\/%]/g, c => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
		if (v && v._str) {
			let s = "<";
			for (let b of v._str) s += b.toString(16).padStart(2, "0");
			return s + ">";
		}
		if (Array.isArray(v)) return "[" + v.map(serialize).join(" ") + "]";
		if (v && v._dict) {
			let s = "<<";
			for (let [k, val] of v._dict) s += "/" + k + " " + serialize(val) + " ";
			return s + ">>";
		}
		return "null";
	}

	// Aplatit l'arbre de titres en une liste d'objets PDF chaînés.
	// `headings` : [{ title, level, pageIndex, y }] dans l'ordre du document.
	function buildOutlineObjects(headings, pageRefs, firstObjNum) {
		// Construction de l'arbre à partir des niveaux.
		let rootItems = [];
		let stack = [];
		for (let h of headings) {
			let lvl = Math.max(1, Math.min(6, h.level | 0 || 1));
			let node = { title: h.title, pageIndex: h.pageIndex, y: h.y, children: [] };
			while (stack.length >= lvl) stack.pop();
			if (!stack.length) { rootItems.push(node); stack.push(node); }
			else { stack[stack.length - 1].children.push(node); stack.push(node); }
		}

		// Attribution des numéros d'objet, parcours préfixe.
		let outlineRootNum = firstObjNum;
		let next = firstObjNum + 1;
		let assign = (nodes) => {
			for (let n of nodes) { n.num = next++; assign(n.children); }
		};
		assign(rootItems);

		let objects = [];
		let emit = (nodes, parentNum) => {
			for (let i = 0; i < nodes.length; i++) {
				let n = nodes[i];
				let parts = ["/Title " + esc(n.title), "/Parent " + parentNum + " 0 R"];
				if (i > 0) parts.push("/Prev " + nodes[i - 1].num + " 0 R");
				if (i < nodes.length - 1) parts.push("/Next " + nodes[i + 1].num + " 0 R");
				if (n.children.length) {
					parts.push("/First " + n.children[0].num + " 0 R");
					parts.push("/Last " + n.children[n.children.length - 1].num + " 0 R");
					// Négatif = branche repliée à l'ouverture.
					parts.push("/Count " + (-n.children.length));
				}
				let pref = pageRefs[Math.max(0, Math.min(pageRefs.length - 1, n.pageIndex | 0))];
				if (pref) {
					let y = (typeof n.y === "number" && isFinite(n.y)) ? Math.round(n.y) : null;
					parts.push("/Dest [" + pref.num + " " + pref.gen + " R /XYZ null "
						+ (y === null ? "null" : y) + " null]");
				}
				objects.push({ num: n.num, body: "<<" + parts.join(" ") + ">>" });
				emit(n.children, n.num);
			}
		};
		emit(rootItems, outlineRootNum);

		let rootParts = ["/Type /Outlines"];
		if (rootItems.length) {
			rootParts.push("/First " + rootItems[0].num + " 0 R");
			rootParts.push("/Last " + rootItems[rootItems.length - 1].num + " 0 R");
		}
		// Seuls les items de premier niveau sont visibles (branches repliées).
		rootParts.push("/Count " + rootItems.length);
		objects.unshift({ num: outlineRootNum, body: "<<" + rootParts.join(" ") + ">>" });

		return { objects: objects, rootNum: outlineRootNum, topCount: rootItems.length };
	}

	// Ajoute (ou remplace) le sommaire d'un PDF. Rend un nouvel Uint8Array.
	async function writeOutline(buf, headings, options) {
		options = options || {};
		if (!headings || !headings.length) throw new Error("aucun titre à écrire");

		let xref = new XRef(buf);
		await xref.parse();
		if (xref.isEncrypted()) throw new Error("PDF chiffré : écriture refusée");

		let rootRef = xref.trailer.get("Root");
		if (!isRef(rootRef)) throw new Error("/Root introuvable");
		let catalog = await xref.fetch(rootRef.num);
		if (!catalog || !catalog._dict) throw new Error("catalogue illisible");

		let pageRefs = await xref.getPageRefs();
		if (!pageRefs.length) throw new Error("aucune page trouvée");

		// Numéro du premier objet libre.
		let size = xref.trailer.get("Size");
		let maxNum = 0;
		for (let k of xref.entries.keys()) if (k > maxNum) maxNum = k;
		let firstFree = Math.max(typeof size === "number" ? size : 0, maxNum + 1);

		let built = buildOutlineObjects(headings, pageRefs, firstFree);

		// Reconstruire le catalogue : on recopie ses octets d'origine et on
		// injecte /Outlines, en retirant l'ancien s'il y en avait un.
		let srcBuf = catalog._srcBuf || buf;
		let [ds, de] = catalog.range;
		let inner = latin1(srcBuf, ds + 2, de - 2);
		inner = inner.replace(/\/Outlines\s+\d+\s+\d+\s+R/g, "");
		let newCatalog = "<<" + inner + " /Outlines " + built.rootNum + " 0 R>>";

		// Assemblage de la mise à jour incrémentale.
		let chunks = [buf];
		let offset = buf.length;
		// Un saut de ligne franc évite de coller le nouvel objet à « %%EOF ».
		let sep = (buf[buf.length - 1] === 0x0a) ? "" : "\n";
		if (sep) { chunks.push(bytesOf(sep)); offset += sep.length; }

		let written = [];   // {num, offset}
		let pushObj = (numObj, body) => {
			let s = numObj + " 0 obj\n" + body + "\nendobj\n";
			written.push({ num: numObj, offset: offset });
			let b = bytesOf(s);
			chunks.push(b);
			offset += b.length;
		};

		pushObj(rootRef.num, newCatalog);
		for (let o of built.objects) pushObj(o.num, o.body);

		let startxrefOld = lastStartxref(buf);
		let newSize = firstFree + built.objects.length;

		// Le type de section doit suivre celui du fichier d'origine : mélanger
		// table et flux fonctionne chez la plupart des lecteurs, mais pas tous.
		let usesStream = sectionIsStream(buf, startxrefOld);
		let xrefOffset = offset;
		let tail;
		if (usesStream) {
			tail = buildXRefStream(written, newSize, rootRef, xref.trailer, startxrefOld, xrefOffset);
		}
		else {
			tail = buildXRefTable(written, newSize, rootRef, xref.trailer, startxrefOld);
		}
		chunks.push(bytesOf(tail));
		chunks.push(bytesOf("startxref\n" + xrefOffset + "\n%%EOF\n"));

		return concat(chunks);
	}

	function lastStartxref(buf) {
		let sx = lastIndexOfBytes(buf, "startxref", buf.length);
		if (sx === -1) return 0;
		let lex = new Lexer(buf);
		lex.pos = sx + 9;
		let v = lex.parseObject(null);
		return typeof v === "number" ? v : 0;
	}

	function sectionIsStream(buf, off) {
		if (!off || off <= 0 || off >= buf.length) return false;
		let lex = new Lexer(buf);
		lex.pos = off;
		lex.skipWS();
		return latin1(buf, lex.pos, lex.pos + 4) !== "xref";
	}

	// Regroupe les objets écrits en sous-sections contiguës.
	function subsections(written) {
		let sorted = written.slice().sort((a, b) => a.num - b.num);
		let groups = [];
		for (let w of sorted) {
			let last = groups[groups.length - 1];
			if (last && w.num === last.first + last.items.length) last.items.push(w);
			else groups.push({ first: w.num, items: [w] });
		}
		return groups;
	}

	function buildXRefTable(written, newSize, rootRef, trailer, prev) {
		let s = "xref\n";
		for (let g of subsections(written)) {
			s += g.first + " " + g.items.length + "\n";
			for (let it of g.items) {
				s += String(it.offset).padStart(10, "0") + " 00000 n \n";
			}
		}
		s += "trailer\n<< /Size " + newSize + " /Root " + rootRef.num + " " + rootRef.gen + " R";
		let info = trailer.get("Info");
		if (isRef(info)) s += " /Info " + info.num + " " + info.gen + " R";
		let id = trailer.get("ID");
		if (Array.isArray(id)) s += " /ID " + serialize(id);
		if (prev) s += " /Prev " + prev;
		s += " >>\n";
		return s;
	}

	function buildXRefStream(written, newSize, rootRef, trailer, prev, selfOffset) {
		// Le flux xref se décrit lui-même : il faut donc lui réserver un numéro
		// et l'inclure dans ses propres entrées.
		let selfNum = newSize;
		let all = written.concat([{ num: selfNum, offset: selfOffset }]);
		let groups = subsections(all);

		let index = [];
		let rows = [];
		for (let g of groups) {
			index.push(g.first, g.items.length);
			for (let it of g.items) rows.push(it.offset);
		}
		// /W [1 4 2] : type, offset sur 4 octets, génération sur 2.
		let data = new Uint8Array(rows.length * 7);
		let p = 0;
		for (let off of rows) {
			data[p++] = 1;
			data[p++] = (off >>> 24) & 0xff;
			data[p++] = (off >>> 16) & 0xff;
			data[p++] = (off >>> 8) & 0xff;
			data[p++] = off & 0xff;
			data[p++] = 0;
			data[p++] = 0;
		}

		let dict = "<< /Type /XRef /Size " + (selfNum + 1)
			+ " /Index [" + index.join(" ") + "]"
			+ " /W [1 4 2] /Root " + rootRef.num + " " + rootRef.gen + " R";
		let info = trailer.get("Info");
		if (isRef(info)) dict += " /Info " + info.num + " " + info.gen + " R";
		let id = trailer.get("ID");
		if (Array.isArray(id)) dict += " /ID " + serialize(id);
		if (prev) dict += " /Prev " + prev;
		dict += " /Length " + data.length + " >>";

		let head = selfNum + " 0 obj\n" + dict + "\nstream\n";
		let out = head;
		for (let i = 0; i < data.length; i++) out += String.fromCharCode(data[i]);
		out += "\nendstream\nendobj\n";
		return out;
	}

	// ---- Diagnostic ----

	// Ouvre un PDF et rend un état des lieux, sans rien modifier.
	async function inspect(buf) {
		let xref = new XRef(buf);
		await xref.parse();
		return {
			encrypted: xref.isEncrypted(),
			hasOutline: await xref.hasOutline(),
			pageCount: (await xref.getPageRefs()).length,
			xrefType: sectionIsStream(buf, lastStartxref(buf)) ? "stream" : "table"
		};
	}

	return {
		XRef: XRef,
		Lexer: Lexer,
		writeOutline: writeOutline,
		inspect: inspect,
		buildOutlineObjects: buildOutlineObjects,
		inflate: inflate,
		_internals: { serialize: serialize, esc: esc, indexOfBytes: indexOfBytes }
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_PDF;
