// Minimal, dependency-free decoder for OTLP protobuf payloads (metrics + traces).
//
// It converts the binary wire format into the SAME object shape as OTLP/JSON
// (camelCase keys, e.g. resourceMetrics/scopeMetrics/dataPoints), so the adapters
// only have to understand one format. Only the fields this monitor needs are decoded;
// everything else is skipped safely.
//
// Field numbers come from opentelemetry-proto (common/v1, resource/v1, metrics/v1, trace/v1).

// ---------- low-level protobuf reader ----------
class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  eof() { return this.pos >= this.buf.length; }
  varint() {
    // Returns a BigInt to stay exact for 64-bit values.
    let result = 0n, shift = 0n;
    while (true) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  fixed64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  sfixed64() { const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; }
  double() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  bytes() {
    const len = Number(this.varint());
    const v = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return v;
  }
  string() { return this.bytes().toString('utf8'); }
  skip(wireType) {
    switch (wireType) {
      case 0: this.varint(); break;
      case 1: this.pos += 8; break;
      case 2: this.bytes(); break;
      case 5: this.pos += 4; break;
      default: throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  /** Iterate fields: cb(fieldNumber, wireType, reader) must consume or skip. */
  fields(cb) {
    while (!this.eof()) {
      const tag = Number(this.varint());
      const field = tag >>> 3, wt = tag & 7;
      if (cb(field, wt) === false) this.skip(wt);
    }
  }
}

const sub = (r) => new Reader(r.bytes());
const toSigned64 = (u) => BigInt.asIntN(64, u);

// ---------- common ----------
function decodeAnyValue(r) {
  const out = {};
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) out.stringValue = r.string();
    else if (f === 2 && wt === 0) out.boolValue = r.varint() !== 0n;
    else if (f === 3 && wt === 0) out.intValue = toSigned64(r.varint()).toString();
    else if (f === 4 && wt === 1) out.doubleValue = r.double();
    else return false; // arrays / kvlists / bytes: not needed here
  });
  return out;
}

function decodeKeyValue(r) {
  const kv = { key: '', value: {} };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) kv.key = r.string();
    else if (f === 2 && wt === 2) kv.value = decodeAnyValue(sub(r));
    else return false;
  });
  return kv;
}

function decodeResource(r) {
  const res = { attributes: [] };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) res.attributes.push(decodeKeyValue(sub(r)));
    else return false;
  });
  return res;
}

// ---------- metrics ----------
function decodeNumberDataPoint(r) {
  const dp = { attributes: [] };
  r.fields((f, wt) => {
    if (f === 7 && wt === 2) dp.attributes.push(decodeKeyValue(sub(r)));
    else if (f === 2 && wt === 1) dp.startTimeUnixNano = r.fixed64().toString();
    else if (f === 3 && wt === 1) dp.timeUnixNano = r.fixed64().toString();
    else if (f === 4 && wt === 1) dp.asDouble = r.double();
    else if (f === 6 && wt === 1) dp.asInt = r.sfixed64().toString();
    else return false;
  });
  return dp;
}

function decodeHistogramDataPoint(r) {
  const dp = { attributes: [] };
  r.fields((f, wt) => {
    if (f === 9 && wt === 2) dp.attributes.push(decodeKeyValue(sub(r)));
    else if (f === 2 && wt === 1) dp.startTimeUnixNano = r.fixed64().toString();
    else if (f === 3 && wt === 1) dp.timeUnixNano = r.fixed64().toString();
    else if (f === 4 && wt === 1) dp.count = r.fixed64().toString();
    else if (f === 5 && wt === 1) dp.sum = r.double();
    else return false;
  });
  return dp;
}

function decodeDataPointContainer(r, decodePoint) {
  const c = { dataPoints: [] };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) c.dataPoints.push(decodePoint(sub(r)));
    else if (f === 2 && wt === 0) c.aggregationTemporality = Number(r.varint());
    else if (f === 3 && wt === 0) c.isMonotonic = r.varint() !== 0n;
    else return false;
  });
  return c;
}

function decodeMetric(r) {
  const m = { name: '' };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) m.name = r.string();
    else if (f === 3 && wt === 2) m.unit = r.string();
    else if (f === 5 && wt === 2) m.gauge = decodeDataPointContainer(sub(r), decodeNumberDataPoint);
    else if (f === 7 && wt === 2) m.sum = decodeDataPointContainer(sub(r), decodeNumberDataPoint);
    else if (f === 9 && wt === 2) m.histogram = decodeDataPointContainer(sub(r), decodeHistogramDataPoint);
    else return false;
  });
  return m;
}

function decodeScopeMetrics(r) {
  const sm = { metrics: [] };
  r.fields((f, wt) => {
    if (f === 2 && wt === 2) sm.metrics.push(decodeMetric(sub(r)));
    else return false;
  });
  return sm;
}

function decodeResourceMetrics(r) {
  const rm = { scopeMetrics: [] };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) rm.resource = decodeResource(sub(r));
    else if (f === 2 && wt === 2) rm.scopeMetrics.push(decodeScopeMetrics(sub(r)));
    else return false;
  });
  return rm;
}

/** Decode ExportMetricsServiceRequest -> OTLP/JSON-shaped object. */
export function decodeMetricsRequest(buf) {
  const out = { resourceMetrics: [] };
  const r = new Reader(buf);
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) out.resourceMetrics.push(decodeResourceMetrics(sub(r)));
    else return false;
  });
  return out;
}

// ---------- traces ----------
function decodeSpan(r) {
  const s = { name: '', attributes: [] };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) s.traceId = r.bytes().toString('hex');
    else if (f === 2 && wt === 2) s.spanId = r.bytes().toString('hex');
    else if (f === 5 && wt === 2) s.name = r.string();
    else if (f === 7 && wt === 1) s.startTimeUnixNano = r.fixed64().toString();
    else if (f === 8 && wt === 1) s.endTimeUnixNano = r.fixed64().toString();
    else if (f === 9 && wt === 2) s.attributes.push(decodeKeyValue(sub(r)));
    else return false;
  });
  return s;
}

function decodeScopeSpans(r) {
  const ss = { spans: [] };
  r.fields((f, wt) => {
    if (f === 2 && wt === 2) ss.spans.push(decodeSpan(sub(r)));
    else return false;
  });
  return ss;
}

function decodeResourceSpans(r) {
  const rs = { scopeSpans: [] };
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) rs.resource = decodeResource(sub(r));
    else if (f === 2 && wt === 2) rs.scopeSpans.push(decodeScopeSpans(sub(r)));
    else return false;
  });
  return rs;
}

/** Decode ExportTraceServiceRequest -> OTLP/JSON-shaped object. */
export function decodeTraceRequest(buf) {
  const out = { resourceSpans: [] };
  const r = new Reader(buf);
  r.fields((f, wt) => {
    if (f === 1 && wt === 2) out.resourceSpans.push(decodeResourceSpans(sub(r)));
    else return false;
  });
  return out;
}

// ---------- tiny encoder (used only by tests / the demo script) ----------
export const enc = {
  varint(n) {
    let v = BigInt(n); const out = [];
    while (v > 0x7fn) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
    out.push(Number(v)); return Buffer.from(out);
  },
  tag(field, wt) { return enc.varint((field << 3) | wt); },
  len(field, buf) { return Buffer.concat([enc.tag(field, 2), enc.varint(buf.length), buf]); },
  str(field, s) { return enc.len(field, Buffer.from(s, 'utf8')); },
  f64(field, big) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(big)); return Buffer.concat([enc.tag(field, 1), b]); },
  sf64(field, big) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(big)); return Buffer.concat([enc.tag(field, 1), b]); },
  dbl(field, d) { const b = Buffer.alloc(8); b.writeDoubleLE(d); return Buffer.concat([enc.tag(field, 1), b]); },
  vint(field, n) { return Buffer.concat([enc.tag(field, 0), enc.varint(n)]); },
  kv(field, key, value) {
    const any = typeof value === 'number' && Number.isInteger(value)
      ? enc.vint(3, value) : typeof value === 'number' ? enc.dbl(4, value) : enc.str(1, String(value));
    return enc.len(field, Buffer.concat([enc.str(1, key), enc.len(2, any)]));
  },
};
