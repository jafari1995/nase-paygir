// Port of edge-tts 7.3.1 drm.generate_sec_ms_gec_v2 (BigInt, exact).
export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const M = 0xFFFFFFFFn;
const B = (xs: number[]) => xs.map((x) => BigInt(x));
const INIT = B([0x6A09E667,0xBB67AE85,0x3C6EF372,0xA54FF53A,0x510E527F,0x9B05688C,0x1F83D9AB,0x5BE0CD19]);
const STATE = B([0xFD9FBEA2,0x91243CE7,0xBE499094,0xCD2E1E0A,0x6C006F49,0x04BD35AB,0xFEB0A7E4,0x03EFFBD2]);
const SCHED = B([0xEB24BF9E,0x1558691F,0xA0C09EE2,0x0CFA32BA,0xA622EE8C,0xD1DD9491,0xC0DD25A0,0xF9E70AB6,0xF0C31573,0x7058CE4E,0x7188E606,0x00E5AB33,0xD258B060,0x72766564]);
const K = B([0x428A2F98,0x71374491,0xB5C0FBCF,0xE9B5DBA5,0x3956C25B,0x59F111F1,0x923F82A4,0xAB1C5ED5,0xD807AA98,0x12835B01,0x243185BE,0x550C7DC3,0x72BE5D74,0x80DEB1FE,0x9BDC06A7,0xC19BF174,0xE49B69C1,0xEFBE4786,0x0FC19DC6,0x240CA1CC,0x2DE92C6F,0x4A7484AA,0x5CB0A9DC,0x76F988DA,0x983E5152,0xA831C66D,0xB00327C8,0xBF597FC7,0xC6E00BF3,0xD5A79147,0x06CA6351,0x14292967,0x27B70A85,0x2E1B2138,0x4D2C6DFC,0x53380D13,0x650A7354,0x766A0ABB,0x81C2C92E,0x92722C85,0xA2BFE8A1,0xA81A664B,0xC24B8B70,0xC76C51A3,0xD192E819,0xD6990624,0xF40E3585,0x106AA070,0x19A4C116,0x1E376C08,0x2748774C,0x34B0BCB5,0x391C0CB3,0x4ED8AA4A,0x5B9CCA4F,0x682E6FF3,0x748F82EE,0x78A5636F,0x84C87814,0x8CC70208,0x90BEFFFA,0xA4506CEB,0xBEF9A3F7,0xC67178F2]);
const ADJ = 0xC9DC06A7n;
const KB = [...K.slice(0, 14), ADJ, ...K.slice(15)];
const S0ADJ = 0x059C0B80n, S1ADJ = 0x000B92C0n;
const CS = [[0xE82E91B1,0xB32700D0],[0x44DE24C6,0x88DFF51D],[0x3BEB65BC,0x29514038],[0xC89C5933,0xB328CBDF],[0x8D1EC211,0xD405B4D5],[0x314EF5D5,0x26E55F3C],[0xE92491B1,0x607801C6],[0xF0A5B9D5,0x82B2C1FB],[0x06064CF3,0xFA51A3DA],[0xDA79FA60,0x207CC464],[0xBED20560,0x3C3C74F3],[0x89F9C9F8,0xD2D14B61],[0x35FA38C6,0xBB04A2C1],[0xCB49E3C6,0xC5626167]].map(([a, b]) => [BigInt(a), BigInt(b)]);
const CSF = 0x82893933n, CSA0 = 0xF2F90B1An, CSA1 = 0x0B1A0000n;

const rol16 = (v: bigint) => { v &= M; return ((v << 16n) | (v >> 16n)) & M; };
const sig0 = (v: bigint) => ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & M;
const sig1 = (v: bigint) => ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & M;

function rounds(state: bigint[], w: bigint[], first = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? KB : K;
  for (let i = first; i < 64; i++) {
    const re = e * 0x100000001n, ra = a * 0x100000001n;
    const t1 = h + ((re >> 6n) ^ (re >> 11n) ^ (re >> 25n)) + (g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = ((ra >> 2n) ^ (ra >> 13n) ^ (ra >> 22n)) + ((a & b) | (c & (a | b)));
    [a, b, c, d, e, f, g, h] = [(t1 + t2) & M, a, b, c, (d + t1) & M, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}
function expand(w: bigint[], first = 16) {
  for (let i = first; i < 64; i++) {
    const x = w[i - 2], y = w[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    w.push((s1 + w[i - 7] + s0 + w[i - 16]) & M);
  }
}
const be = (b: Uint8Array) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
function shaInit(d: Uint8Array): bigint[] {
  const w: bigint[] = [...Array(14).fill(0n), be(d.slice(0, 3))];
  w.push(be(d.slice(3, 7)));
  for (let i = 16; i < 30; i++) {
    let v = SCHED[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (sig1(w[i - 2]) ^ S1ADJ) : sig1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (sig0(w[i - 15]) ^ S0ADJ) : sig0(w[i - 15]);
    w.push(v & M);
  }
  w.push((sig1(w[28]) + w[23] + sig0(w[15]) + w[14] + ADJ - K[14]) & M);
  expand(w, 31);
  const wk = rounds(STATE, w, 14);
  return INIT.map((x, i) => (x + wk[i]) & M);
}
function shaDigest(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const zeros = ((55 - length) % 64 + 64) % 64;
  const rest = data.slice(7);
  const padded = new Uint8Array(rest.length + 1 + zeros + 8);
  padded.set(rest); padded[rest.length] = 0x80;
  const bits = BigInt(length * 8);
  for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xFFn);
  let st = shaInit(data.slice(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w: bigint[] = [];
    for (let j = 0; j < 16; j++) w.push(be(padded.slice(off + 4 * j, off + 4 * j + 4)));
    expand(w);
    const wk = rounds(st, w);
    st = st.map((x, i) => (x + wk[i]) & M);
  }
  const out = new Uint8Array(32);
  st.forEach((x, i) => { for (let j = 0; j < 4; j++) out[4 * i + j] = Number((x >> BigInt(24 - 8 * j)) & 0xFFn); });
  return out;
}
const le32 = (b: Uint8Array, o: number) => BigInt(b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + (BigInt(b[o + 3]) << 24n);
function cs64(data: Uint8Array, digest: Uint8Array): [bigint, bigint] {
  let ka = le32(digest, 0) | 1n, kb = le32(digest, 4) | 1n;
  const factors = [(ka * CSF) & M, (kb * CSF) & M];
  const terms = CS.map(([c], i) => (c * factors[i % 2]) & M);
  const offsets = CS.map(([, o]) => o);
  const src = new Uint8Array(1 + data.length); src.set(data, 1);
  const padLen = src.length + ((4 - (src.length % 4)) % 4);
  const padded = new Uint8Array(padLen); padded.set(src);
  const words: bigint[] = [];
  for (let o = 0; o < padLen; o += 4) words.push(le32(padded, o));
  if (words.length % 2) words.push(0n);
  words.forEach((word, i) => {
    let term = word * (i % 2 === 0 ? ka : kb);
    let off = rol16(word) * (i % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (i === 0) { term += CSA0 * factors[0]; off += CSA1; }
    terms.push(term & M); offsets.push(off & M);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M);
    let q = (t * 0x76F50F34n) & M;
    swapAcc += (rol16(q) * 0xC3EFEA97n + q) & M;
    t = rol16((offsets[i + 1] + y) & M);
    q = (t * 0x1881CE3Cn) & M;
    swapLast = (rol16(q) * 0x35BD1EC9n + q) & M;
    swapAcc = (swapAcc + swapLast) & M;
    state = (state * ka + x) & M;
    state = (rol16(state) * 0xCF98B111n) & M;
    state = (rol16(state) * 0x87085B9Fn) & M;
    state = (rol16(state) * 0x12CEB96Dn) & M;
    state = (rol16(state) * 0x257E1D83n) & M;
    acc += state;
    t = (state * kb + y) & M;
    t = (rol16(t) * 0xA27416F5n) & M;
    t = (rol16(t) * 0xD38396FFn) & M;
    state = (rol16((rol16(t) * 0x7C932B89n) & M) * 0xBFA49F69n) & M;
    acc = (acc + state) & M;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
let _cache: [string, string] | null = null;
export function secMsGec(unix?: number): string {
  let ticks = (unix ?? Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const s = BigInt(Math.round(ticks)).toString() + TRUSTED_CLIENT_TOKEN;
  if (_cache && _cache[0] === s) return _cache[1];
  const data = new TextEncoder().encode(s);
  const dg = shaDigest(data);
  const [p, q] = cs64(data, dg);
  const c = new Uint8Array(8);
  for (let i = 0; i < 4; i++) { c[i] = Number((p >> BigInt(8 * i)) & 0xFFn); c[4 + i] = Number((q >> BigInt(8 * i)) & 0xFFn); }
  const out = `${hex(c)}-${hex(dg)}`;
  _cache = [s, out];
  return out;
}
