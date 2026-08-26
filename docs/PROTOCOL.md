# PROTOCOL — 第一頁與第二頁之間的契約

> **這份文件是兩個頁面之間唯一的介面。**
> 第一頁（`frontend/src/pages/live/`）與第二頁（`frontend/src/pages/report/`）
> 由不同的人開發，兩邊的程式碼**不得互相 import**。
> 唯一的共享物是 `frontend/src/protocol/`，它是本文件的 TypeScript 實作。
>
> 契約的變更需要雙方同意。變更時請同步更新本文件、`frontend/src/protocol/`
> 與 `backend/protocol.py`，三者必須一致。

版本：`PROTOCOL_VERSION = 1`

---

## 1. 全景

```
video1.mp4 (1920×1080, 60fps)
      │
      │  POST /api/sessions
      ▼
┌──────────────────────────────────────────────┐
│ gateway  :8080                               │
│  1. ffmpeg 依固定 ROI 裁切抽幀 (extract_fps)  │
│  2. 全片跑 GNS        (gns_fps)              │
│  3. 只對非食道 NBI 幀跑 GIM (gim_fps)        │
│  4. status → ready                           │
│                                              │
│  以上每算完一批就用 frames 事件推出去；        │
│  另有 /analyze 可對任一時間點就地推一幀，      │
│  結果寫回同一份 session，兩條路不重複計算。    │
└──────────────────────────────────────────────┘
      │                          │
      │ 第一頁讀                  │ 第二頁讀（相同的 API，沒有特權通道）
      ▼                          ▼
  /live                      /report
```

**第一頁不會直接呼叫第二頁，第二頁也不會直接呼叫第一頁。**
兩邊都只跟 gateway 說話。第一頁建立 session，第二頁消費 session。
「第一頁收到影片後第二頁自動開始背景處理」是這樣達成的：第二頁訂閱
`/api/sessions/{id}/events`，收到 `ready` 事件後自行啟動它的下游流程。

---

## 2. 座標系（疊圖對齊的唯一依據）

原始影片是 1920×1080 的內視鏡主機畫面，左側是文字欄，中間偏右是八角形的
內視鏡視野。模型只吃視野本身。

```
ROI = { x: 799, y: 105, width: 1000, height: 871 }
```

此數值由 video1/video2 各 5 個時間點實測，完全一致（同一台 GIF-H290）。
它同時也裁掉了左欄的病歷號與生日。

**規則：所有影像與 mask 一律位於 ROI 像素座標系。**

- `image_url` 指向的 JPEG 尺寸 = `ROI.width × ROI.height`
- `mask_url` 指向的 PNG 尺寸 = `ROI.width × ROI.height`，**RGBA**：
  背景為完全透明，IM 像素已上色（紫，alpha 130）。
  live 頁可直接用 `<img>` 疊上去；report 頁會讀取 alpha channel 並只畫病灶
  boundary，兩者都不會改變原始 mask 或面積數值。
  需要數值的話用 `GimResult.score` / `GimResult.area`，不要去讀 mask 像素。
- gateway 內部無論模型輸入被 resize 成幾乘幾，回傳前一律回到 ROI 尺寸

前端要把 mask 疊到 `<video>` 上時，只需要做一次幾何換算：

```
1. 取得 <video> 元素在頁面上的實際內容矩形（object-fit: contain 會產生黑邊，
   需先扣掉）→ contentRect
2. scale = contentRect.width / 1920
3. mask 疊放位置 = {
     left: contentRect.left + ROI.x * scale,
     top:  contentRect.top  + ROI.y * scale,
     width:  ROI.width  * scale,
     height: ROI.height * scale,
   }
```

`frontend/src/protocol/geometry.ts` 提供 `roiRectInVideo(videoEl)` 直接算好。
**不要自己重新推導這段數學**，否則兩個頁面會對不齊。

---

## 3. 型別

TypeScript 定義在 `frontend/src/protocol/types.ts`，Python 鏡像在
`backend/protocol.py`。以下為規格正本。

### 3.1 SessionManifest

```ts
type SessionStatus = 'extracting' | 'scanning' | 'ready' | 'failed'

interface SessionManifest {
  protocol_version: 1
  session_id: string            // uuid4 hex
  created_at: string            // ISO 8601
  status: SessionStatus
  error: string | null          // status === 'failed' 時的原因

  video: {
    path: string                // 後端本機絕對路徑
    filename: string
    width: number               // 1920
    height: number              // 1080
    fps: number                 // 來源影片 fps，例如 60
    duration_s: number
    media_url: string | null    // 可直接餵給 <video> 的串流網址（支援 Range）
  }                             // 影片不在 VIDEO_DIR 內時為 null

  roi: { x: number; y: number; width: number; height: number }

  sampling: {
    extract_fps: number         // 抽幀取樣率，預設 15
    gns_fps: number             // GNS 取樣率，預設 15
    gim_fps: number             // GIM 取樣率，預設 5（且只跑 NBI 幀）
  }

  // 幀表在 ffmpeg 開跑前就依 duration × extract_fps 建好（隨選推論才有位置可寫），
  // 抽幀結束後再依實際檔案數校正，通常差 1~2 幀。
  // FrameRecord.image_url 要等 progress.extract 走到該位置才保證存在。
  frame_count: number           // 抽出的幀總數
  progress: {                   // 0.0 ~ 1.0
    extract: number
    gns: number
    gim: number
  }
}
```

`status` 的轉移是單向的：
`extracting → scanning → ready`，任一步失敗則 `→ failed`。

### 3.2 FrameRecord

```ts
type Modality = 'WL' | 'NBI'

type RegionId =
  | 'esophagus' | 'cardia' | 'body' | 'angle' | 'antrum' | 'duodenum' | 'unknown'

interface GnsResult {
  class_name: string            // GNS 原始 16 類之一，例如 'G1_WL'
  modality: Modality
  region: RegionId              // class_name 經對應表換算，見 §4
  confidence: number            // 0..1
  probs: Record<string, number> // 16 類完整機率
}

interface GimResult {
  score: 0 | 1 | 2              // IM 嚴重度分級
  area: number                  // IM 面積百分比 0..100
  mask_url: string | null       // score === 0 時為 null
}

interface FrameRecord {
  index: number                 // 從 0 起算的抽幀序號
  t: number                     // 影片時間（秒）★ 對齊 <video>.currentTime 的唯一依據
  image_url: string             // ROI 裁切後的 JPEG

  gns: GnsResult | null         // 尚未掃到 / 該幀未取樣時為 null
  gim: GimResult | null         // 同上；WL 幀永遠為 null（GIM 只在 NBI 上有效）
}
```

**時間是唯一的對齊鍵。** 不要用 index 去猜時間，因為三個取樣率不同。
查詢當下該顯示哪一幀，一律用 `t` 做最近鄰搜尋，
`frontend/src/protocol/lookup.ts` 提供 `frameAt(frames, currentTime)`。

### 3.3 事件（SSE）

`GET /api/sessions/{id}/events` 是 `text/event-stream`，事件型別：

```ts
type SessionEvent =
  | { type: 'progress'; session_id: string; progress: SessionManifest['progress'] }
  | { type: 'status';   session_id: string; status: SessionStatus; error: string | null }
  | { type: 'frames';   session_id: string; frames: FrameRecord[] }
  | { type: 'ready';    session_id: string; frame_count: number }
```

`frames` 事件會在掃描過程中**持續推送剛算完的批次**（GNS 每 32 幀、GIM 每 8 幀），
以及每一次隨選推論的結果。用 `FrameRecord.index` 就地覆蓋你手上的表即可。
不想做漸進式更新的話可以忽略它，等 `ready` 再一次抓全部。

`ready` 事件保證在發出時，`GET /api/sessions/{id}/frames` 已包含全部結果。
**第二頁應該監聽 `ready` 來自動啟動它的下游流程。**

---

## 4. GNS 類別 → 解剖部位對應

GNS 原始 16 類：
`G1_WL G1_NBI G2_WL G2_NBI G3_WL G3_NBI G4_WL G4_NBI G5_WL G5_NBI G6_WL G6_NBI D E_WL E_NBI none`

論文與程式碼中 `G1–G6` 是不透明編號、無記載的解剖對應。目前採用的對應表：

| GNS | region |
|-----|--------|
| G1, G2 | `antrum` |
| G3, G4 | `body` |
| G5 | `angle` |
| G6 | `cardia` |
| E | `esophagus` |
| D | `duodenum` |
| none | `unknown` |

此表定義於 `backend/protocol.py` 的 `REGION_MAP`，是**單一事實來源**，
前端不得自行硬寫另一份。若之後對應有修正，改該處即可。

---

## 5. HTTP API

Base URL 預設 `http://127.0.0.1:8080`。

### `POST /api/sessions`
建立 session 並立刻開始背景處理。

```jsonc
// request
{
  "video_path": "/abs/path/video1.mp4",
  "sampling": { "extract_fps": 15, "gns_fps": 15, "gim_fps": 5 }  // 可省略，用預設
}
// response 201
{ /* SessionManifest, status = 'extracting' */ }
```

### `GET /api/sessions`
回傳 `SessionManifest[]`，最新的在前。

### `GET /api/sessions/{id}`
回傳單一 `SessionManifest`。輪詢進度用；但建議改用 SSE。

### `GET /api/sessions/{id}/frames`
查詢參數：`from_t`、`to_t`（秒，皆可省略）、`only_scanned`（布林，預設 false）。

```jsonc
{ "session_id": "...", "count": 12600, "frames": [ /* FrameRecord[] */ ] }
```

> 12,600 筆一次回傳約數 MB。第一頁的做法是啟動時抓一次全量進記憶體，
> 之後純前端查表；第二頁若只要摘要，用 `from_t`/`to_t` 分段抓。

### `POST /api/sessions/{id}/analyze`
立刻分析 `t` 這個時間點，不等背景掃描走到那裡。

```jsonc
// request
{ "t": 692.75 }
// response：一筆 FrameRecord
```

用途是第一頁的即時判讀：影片播到或跳到掃描還沒覆蓋的位置時，就地推一幀。

- **冪等**。該幀若已被掃描或先前的隨選推論算過，直接回傳既有結果，不會重算。
- 結果會**寫回 session**，所以背景掃描之後會跳過它，第二頁拿到的與第一頁顯示的完全一致。
- 同時也會用 `frames` 事件廣播出去。
- 該幀若還沒被抽出來，gateway 會用 ffmpeg 單幀 seek 補（約 200ms，與時間點深淺無關）；
  已抽出來的話就只是讀檔，整體約 25–30ms。
- 伺服器端一次只跑一個隨選推論。呼叫端應自行做 single-flight，不要塞滿佇列。

### `GET /api/sessions/{id}/events`
SSE，見 §3.3。連線建立時會先補送一次當下的 `status` 與 `progress`。

### `GET /api/videos`
列出後端 `VIDEO_DIR` 底下可用的影片，供第一頁選片。

```jsonc
{ "videos": [ { "path": "...", "filename": "video1.mp4", "size_bytes": 2503119646 } ] }
```

### `POST /api/videos`
`multipart/form-data`，欄位名 `file`。把影片存進 `VIDEO_DIR`，回傳一筆 `VideoFile`。

檔名只取 basename（不可能寫到 `VIDEO_DIR` 之外），同名會自動加 `-1`、`-2` 後綴，
副檔名限 `.mp4 .avi .mov .mkv`，其餘回 400。伺服器端以 4MB 分塊寫入磁碟，
不會把整支影片讀進記憶體。

### `POST /api/cgi/predict`  ← 第二頁專用
代理到 CGI 服務。gateway 只負責轉發，**不決定 A/B/C 三池怎麼挑**——
那是第二頁的職責。

```jsonc
// request：三個影像池，每個元素是 base64 JPEG（不含 data: 前綴）
{ "pool_A": ["..."], "pool_B": ["..."], "pool_C": ["..."] }
// response
{ "top_10_pairs": [ { "probability": 0.93, "img1": "...", "img2": "...", "img3": "..." } ] }
```

CGI 是 corpus-predominant gastritis 模型，輸入為
**三張白光影像：antrum (A) / body (B) / cardia (C)**。
論文所稱 cardia 實際指 high/upper corpus。三池都應只取 `modality === 'WL'` 的幀。

### 靜態檔
- `GET /files/{session_id}/frames/{index:06d}.jpg`
- `GET /files/{session_id}/masks/{index:06d}.png`

`FrameRecord` 裡的 `image_url` / `mask_url` 已是可直接使用的相對路徑。

---

## 6. 給第二頁開發者的約定

1. **只從 `frontend/src/protocol/` 取型別與工具函式**，不要 import
   `pages/live/` 底下任何東西。
2. **不要修改 `frontend/src/protocol/`**，需要變更請提出討論。
3. 第二頁的所有程式碼放在 `frontend/src/pages/report/` 底下。
4. 自動觸發流程的正確做法：

```ts
import { subscribeSession, getFrames } from '@/protocol/client'

subscribeSession(sessionId, (ev) => {
  if (ev.type === 'ready') {
    const frames = await getFrames(sessionId)
    // 這裡是你的地盤：分池、呼叫 /api/cgi/predict、組報告
  }
})
```

5. 第一頁保證：一旦 `ready`，`frames` 內每一筆的 `gns` 皆非 null
   （`gim` 仍可能為 null——WL 幀本來就沒有）。
6. 報告頁目前的後處理政策：CGI 候選必須通過曝光、暗區、反光與清晰度 gate；
   GIM 必須通過同部位、1 秒內 3 張至少 2 張陽性的 temporal consensus，之後才
   合併成 positive episodes。這些是 report policy，不會覆寫 session 中的原始結果。

---

## 7. 已知限制

- GNS 全片區域準確率約 80%（video1）/ 60%（video2），插入段、十二指腸、
  賁門最弱。這是模型上限。
- GIM 只在 NBI 影像上訓練，白光幀的輸出無意義，因此被硬性關閉。
- `G1–G6` 的解剖對應是經驗推得，非論文記載。
