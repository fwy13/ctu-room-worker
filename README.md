# CTU Room Worker

Cloudflare Worker đặt phòng thư viện CTU cho nhiều sinh viên, nhiều phòng. Tự động lấy cookie phiên sau đăng nhập; chỉ xác nhận thành công khi phản hồi có thông báo `tb_ok` chính xác.

> Chỉ sử dụng tài khoản được cho phép và tuân thủ quy định của hệ thống thư viện. Không dùng cấu hình nhiều tài khoản để vượt giới hạn đặt phòng.

## Cấu trúc

```text
ctu-room-worker/
├── src/index.js                 # HTTP API, đăng nhập, cookie, đặt phòng
├── config/bookings.json         # Danh sách phòng, ngày và sinh viên
├── students.example.json        # Mẫu credentials (KHÔNG có mật khẩu thật)
├── .dev.vars.example            # Mẫu secret khi chạy local
├── .github/workflows/deploy.yml # Tự động deploy khi push main
├── wrangler.jsonc               # Cấu hình Cloudflare Worker, KV, Cron
├── package.json
└── README.md
```

## 1. Yêu cầu

- Node.js LTS, npm, tài khoản Cloudflare, tài khoản GitHub.
- Tài khoản CTU hợp lệ và được phép dùng.

## 2. Chỉnh cấu hình phòng và sinh viên

Mở `config/bookings.json`. Đặt `enabled` thành `true` khi muốn kích hoạt lịch chạy và `dryRun` thành `false` khi sẵn sàng gửi request thật.

Mỗi job có `studentIds` và `rooms`. Worker sẽ tạo **từng cặp student × room** trong cùng job. Ví dụ 2 sinh viên × 2 phòng = 4 lượt đăng ký. Nếu muốn mỗi người đặt một phòng riêng, tạo **một job riêng cho từng người**.

Các trường phòng giữ đúng form của hệ thống:

| Trường | Ý nghĩa |
|---|---|
| `gc` | Mục đích đăng ký, ví dụ `Mượn Tivi. ` |
| `id_c` | ID nhóm/loại phòng trong request CTU |
| `id_p` | ID phòng |
| `ngay_hoc` | Ngày đăng ký, định dạng `DD-MM-YYYY` |
| `sv_n` | Số lượng sinh viên |

`maxRequestsPerRun` hạn chế tổng số lượt đặt trong một lần chạy (mặc định 20). `delayMs` đặt khoảng nghỉ giữa các lượt (mặc định 1000ms). Chỉ đặt những phòng/ngày mà hệ thống CTU cho phép.

## 3. Tạo Cloudflare KV

Đăng nhập Cloudflare bằng CLI:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create BOOKINGS
```

Sao chép **namespace ID** trả về và thay `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` trong `wrangler.jsonc`. Sau đó commit thay đổi này.

KV dùng để lưu đánh dấu `done:student:category:room:date` sau khi máy chủ xác nhận đăng ký thành công. Nó giúp tránh lặp trong những lần chạy tiếp theo, **không phải khóa giao dịch tuyệt đối**: hai Worker chạy đồng thời vẫn có thể cùng gửi yêu cầu. Không kích hoạt `/run` đồng thời với Cron nếu cần tránh tuyệt đối.

## 4. Cài Secrets

Chạy:

```bash
npx wrangler secret put STUDENTS_JSON
npx wrangler secret put API_KEY
```

Với `STUDENTS_JSON`, nhập JSON theo cấu trúc trong `students.example.json`, thay bằng username và password thật. Ví dụ:

```json
{"student_a":{"username":"YOUR_ID_A","password":"YOUR_PASSWORD_A"},"student_b":{"username":"YOUR_ID_B","password":"YOUR_PASSWORD_B"}}
```

**Không commit JSON chứa mật khẩu thật.** Secrets lưu trong Cloudflare, không nằm trong repo.

`API_KEY` là mã bí mật tự chọn để bảo vệ API thủ công. Nên dùng chuỗi ngẫu nhiên dài, khác hoàn toàn mật khẩu CTU.

### Chạy local (không gửi request thật theo cấu hình mẫu)

Sao chép `.dev.vars.example` thành `.dev.vars`, sửa giá trị local. File `.dev.vars` đã được gitignore. Chạy `npm run dev`.

## 5. Deploy

```bash
npm run deploy
```

Mở URL `https://ctu-room-worker.YOUR_SUBDOMAIN.workers.dev` mà Wrangler in ra.

### API kiểm tra kế hoạch

```bash
curl -H 'Authorization: Bearer YOUR_API_KEY' 'https://YOUR_WORKER.workers.dev/plan'
```

### API chạy ngay

```bash
curl -X POST -H 'Authorization: Bearer YOUR_API_KEY' 'https://YOUR_WORKER.workers.dev/run'
```

Cấu hình mẫu có `enabled=false` và `dryRun=true`, nên sẽ không gửi đăng ký thật. Sau khi kiểm tra `/plan`, chuyển `enabled=true`, nhưng giữ `dryRun=true` để xem kết quả dựng kế hoạch. Cuối cùng chuyển `dryRun=false` nếu muốn gửi thật.

## 6. Cron Trigger

Mặc định trong `wrangler.jsonc`: `0 0 * * *` nghĩa là **07:00 giờ Việt Nam mỗi ngày** (Cron sử dụng UTC). Thay lịch cho phù hợp nếu cần. Mỗi lần Cron chạy sẽ xử lý các job đang bật, bỏ qua những cặp đã được ghi nhận thành công trong KV.

Ví dụ 08:30 Việt Nam = `30 1 * * *` UTC.

> Lưu ý: Worker không được thiết kế để dò thời điểm mở phòng bằng request liên tục. Chỉ chọn một lịch phù hợp với hướng dẫn CTU.

## 7. GitHub Actions (deploy khi push)

Tạo **Cloudflare API Token** có quyền chỉnh Workers trong tài khoản tương ứng. Trên GitHub repo, vào `Settings > Secrets and variables > Actions` để thêm:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Mỗi lần push lên nhánh `main`, workflow `.github/workflows/deploy.yml` sẽ deploy lên Cloudflare. Secrets **CTU** (`STUDENTS_JSON`, `API_KEY`) vẫn nằm trong Cloudflare và không cần đưa vào GitHub Actions.

## 8. Kiểm tra kết quả và lưu ý

- Login thành công khi có `<div class='tb_ok'>Xin chào :)</div>`.
- Đăng ký thành công khi có `<div class='tb_ok'>Đăng ký thành công :)</div>`.
- Trả về `stage: 'session'`, `login`, `booking`, hoặc `network` để xác định lỗi; không ghi cookie/mật khẩu vào log.
- Nếu không xác nhận thành công, Worker không đánh dấu KV. Kiểm tra trên website trước khi chạy lại để tránh tạo bản ghi trùng nếu response bị mất.
- Với Cookie `BNES_PHPSESSID` hoặc lớp chống bot, Worker có thể không dùng được nếu website yêu cầu xác thực/challenge bổ sung; repo này không bypass lớp bảo vệ đó.
- `GET /plan` và `POST /run` đều yêu cầu `Authorization: Bearer <API_KEY>`.
- Website có thể thay đổi định dạng HTML, API hoặc quy định đặt phòng.
