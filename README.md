# AI Token Monitor

Local server theo dõi lượng token tiêu thụ của **Claude Code** và **GitHub Copilot Chat (VS Code)**, có dashboard web tự làm mới.

- Không cần cài thêm thư viện nào, chỉ cần **Node.js 18+**.
- Dữ liệu chỉ nằm trên máy bạn (`data/usage.jsonl`), server mặc định chỉ lắng nghe ở `127.0.0.1`.
- Chỉ thu **số lượng token**, không thu nội dung prompt hay câu trả lời.

## Cách hoạt động

Cả hai công cụ đều có sẵn khả năng xuất số liệu qua OpenTelemetry (OTLP). Server này đóng vai một OTLP collector tối giản ở cổng `4318`:

| Công cụ | Gửi gì | Server đọc |
|---|---|---|
| Claude Code | metrics → `/v1/metrics` | `claude_code.token.usage` (input / output / cacheRead / cacheCreation) và `claude_code.cost.usage` (USD) |
| Copilot Chat (VS Code) | traces → `/v1/traces` | span `chat`: `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read…`, `cache_creation…` |
| Bất kỳ công cụ nào | JSON → `/ingest` | `{ "source", "model", "type", "tokens", "costUsd" }` |

Server nhận cả JSON lẫn protobuf, có nén gzip hoặc không, và xử lý được cả hai kiểu số liệu delta và cumulative, nên không đếm trùng.

## Bắt đầu nhanh

```bash
npm start                 # chạy server, mở http://127.0.0.1:4318/
node scripts/demo.js      # (tuỳ chọn) gửi dữ liệu mẫu để xem thử dashboard
```

### 1. Claude Code

Claude Code **cố ý bỏ qua** các biến telemetry đặt trong `.claude/settings.json` của repo, nên phải bật ở cấp người dùng. Chạy lệnh sau một lần:

```bash
node scripts/setup-claude.js          # thêm cấu hình vào ~/.claude/settings.json (có backup)
node scripts/setup-claude.js --remove # gỡ bỏ
node scripts/setup-claude.js --print  # chỉ in cấu hình ra, không sửa gì
```

Sau đó khởi động lại Claude Code. Nếu thích dùng biến môi trường trong shell thì đặt như sau:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics
export OTEL_METRIC_EXPORT_INTERVAL=10000
```

**Tự khởi động:** file `.claude/settings.json` trong template có hook `SessionStart`, tự bật server mỗi khi mở Claude Code trong thư mục này. Nếu server đã chạy thì hook không làm gì.

### 2. GitHub Copilot Chat (VS Code)

`.vscode/settings.json` đã bật sẵn telemetry cho Copilot và trỏ về `http://127.0.0.1:4318`. Nếu Copilot không đọc cấu hình ở cấp workspace, hãy chép các dòng `github.copilot.chat.otel.*` vào **User Settings (JSON)**.

**Tự khởi động:** `.vscode/tasks.json` có task chạy khi mở thư mục. Lần đầu VS Code sẽ hỏi có cho phép task tự chạy không, chọn *Allow*.

> Hiện chỉ hỗ trợ **Copilot Chat trong VS Code**, vì đây là phần đã xuất được telemetry. Gợi ý code inline (autocomplete) và các IDE khác chưa có cơ chế xuất token cho cá nhân. Nếu cần, bạn có thể đẩy số liệu qua `/ingest`.

### 3. Nguồn khác

```bash
curl -X POST http://127.0.0.1:4318/ingest \
  -H 'content-type: application/json' \
  -d '{"source":"my-tool","model":"x","type":"output","tokens":1234,"costUsd":0.01}'
```

## Dùng cho dự án khác

Có hai cách:

1. **Chạy một server chung (khuyên dùng):** đặt repo này ở một chỗ cố định, chẳng hạn `~/tools/token-monitor`. Bật Claude Code bằng `setup-claude.js` và bật Copilot trong User Settings một lần. Từ đó mọi dự án đều gửi số liệu về cùng một dashboard.
2. **Kèm vào từng dự án:** chép `.claude/settings.json` (hook) và `.vscode/tasks.json` vào dự án, rồi sửa đường dẫn `scripts/ensure-server.js` thành đường dẫn tuyệt đối tới repo này.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `TM_PORT` | `4318` | Cổng server. Nếu đổi thì phải sửa endpoint ở Claude Code và Copilot cho khớp |
| `TM_HOST` | `127.0.0.1` | Địa chỉ lắng nghe. Nên giữ nguyên để không mở ra mạng ngoài |
| `TM_DATA_DIR` | `./data` | Nơi lưu `usage.jsonl` và `server.log` |

## API

- `GET /api/summary`: tổng token và chi phí, chia theo nguồn, model và loại token
- `GET /api/records?limit=500`: các bản ghi gần nhất
- `GET /api/health`: kiểm tra server còn sống

## Lưu ý

- **Chi phí** chỉ có với Claude Code và là con số **ước tính** do Claude Code tự tính. Nếu bạn dùng gói thuê bao (Pro/Max) thì đây không phải số tiền bị trừ thật. Copilot không gửi chi phí.
- Với Copilot, theo chuẩn OpenTelemetry GenAI thì `input_tokens` đã bao gồm token đọc từ cache. Server tách phần cache ra để "input" mang cùng nghĩa với Claude Code.
- Claude Code mặc định gửi số liệu mỗi 60 giây. Script đặt lại thành 10 giây cho dashboard cập nhật nhanh hơn.
- Muốn xoá dữ liệu: dừng server rồi xoá thư mục `data/`.
- Nếu không thấy số liệu, chạy `claude --debug-file /tmp/cc.log`, rồi tìm các dòng `[3P telemetry]` trong file log để xem lỗi.
