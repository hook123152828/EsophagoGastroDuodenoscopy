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
│  2. GNS 全片分類 (gns_fps)                    │
│  3. GIM 跟著 GNS 的進度同時跑，只吃它已經判為  │
│     NBI 的幀 (gim_fps)——不是等 GNS 全部跑完   │
│  4. status → ready                           │
│                                              │
│  以上每算完一批就用 frames 事件推出去；        │
│  另有 /analyze 可對任一時間點就地推一幀，      │
│  結果寫回同一份 session，兩條路不重複計算。    │
│                                              │
│  息肉（POLYP）不在上面這條掃描裡：它貴上一個   │
│  數量級，只有 /analyze 明確要求時才跑。見 §6。 │
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

**ROI 是逐支影片偵測出來的，不是固定常數。** 建立 session 時偵測一次，
寫進 `SessionManifest.roi`，該次 session 之後都用它。

```jsonc
// video1.mp4 (1920x1080, GIF-H290)
"roi": { "x": 795, "y": 104, "width": 1005, "height": 872 }
// I-GASP_321.avi (512x512，同樣是主機畫面，只是縮小過)
"roi": { "x": 114, "y": 91,  "width": 378,  "height": 327 }
```

偵測方式（`backend/roi.py`）：主機畫面是黑底 + 一欄文字 + 八角形的內視鏡畫面，
文字是細筆畫、內視鏡畫面是大片連通的亮區。取樣 5 幀，各自找最大的連通亮區，
再取各座標的中位數。**偵測不到就拒絕建立 session（422）**，不會退回猜測——
這個裁切正是把病歷號與生日擋在系統之外的東西，猜錯的代價不是外觀問題。

> 早期版本這裡是一行寫死的常數 `799, 105, 1000, 871`，由 video1/video2 實測而來。
> 它只對那一種主機幾何成立：換一支 512×512 的錄影，裁切範圍整個落在畫面之外，
> 抽幀時才以 ffmpeg 的 crop 尺寸錯誤失敗，而且訊息完全沒提到真正的原因。
> **舊 session 的 manifest 仍帶著它們當初的 roi，不受影響。**

**因此不要在程式碼裡寫死 ROI**，一律讀 `manifest.roi`。前端的
`roiRectInVideo(video, roi)` 與 `roiCropStyle(roi, …)` 都是吃參數的。

**規則：所有影像與 mask 一律位於 ROI 像素座標系。**

- `image_url` 指向的 JPEG 尺寸 = `ROI.width × ROI.height`
- `mask_url` 指向的 PNG 尺寸 = `ROI.width × ROI.height`，**RGBA**：
  背景為完全透明，命中的像素已上色（IM 紫 `#a855f7`、息肉黃 `#facc15`，
  兩者 alpha 皆 130）。前端直接用 `<img>` 疊上去即可，不需要做任何像素運算。
  **PNG 存的是「可描邊的形狀」，不是模型的逐像素輸出**——已平滑、已填洞，
  IM 另外把相鄰的斑塊接起來（見 §4.4）。因此它的覆蓋面積會略大於
  `GimResult.area`：**數值一律用 `GimResult.score` / `GimResult.area` /
  `PolypResult.boxes` / `PolypResult.area`，那是模型自己量的，不要去讀 mask 像素。**
- `PolypResult.boxes` 的座標同樣是 **ROI 像素**，與 mask 共用同一個座標系。
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
                                // 來源若不是瀏覽器能解的格式，這裡指向自動
                                // 轉出的 H.264 代理檔，不是 path 那個檔案
  }                             // 影片不在 VIDEO_DIR 內時為 null

  roi: { x: number; y: number; width: number; height: number }

  sampling: {
    extract_fps: number         // 抽幀取樣率，預設 15
    gns_fps: number             // GNS 取樣率，預設 15
    gim_fps: number             // GIM 取樣率，預設 5（且只跑胃部 NBI 幀）
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

interface PolypBox {
  x1: number; y1: number; x2: number; y2: number   // ROI 像素
  confidence: number            // 0..1
}

interface PolypResult {
  boxes: PolypBox[]             // 偵測器的框；沒偵測到時為空陣列
  area: number                  // mask 覆蓋 ROI 的百分比 0..100
  mask_url: string | null       // boxes 為空時為 null
}

interface FrameRecord {
  index: number                 // 從 0 起算的抽幀序號
  t: number                     // 影片時間（秒）★ 對齊 <video>.currentTime 的唯一依據
  image_url: string             // ROI 裁切後的 JPEG

  gns: GnsResult | null         // 尚未掃到 / 該幀未取樣時為 null
  gim: GimResult | null         // 同上；GIM 不適用的幀永遠為 null（見 §4.2）
  polyp: PolypResult | null     // 沒人要過就永遠是 null（見 §4.3）
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

### 4.1 顯示用的部位平滑（不影響 wire format）

逐幀的 GNS 標籤抖動遠大於實際的檢查流程：video1.mp4 上原始標籤跳了 692 次，
標註的實際部位轉換只有 23 次，中位數的連續段只有 0.2 秒。
因此**畫面上顯示的部位不是逐幀取 argmax**，而是
`frontend/src/protocol/lookup.ts` 的 `buildRegionTrack(frames)`：
以 3 秒滑動視窗、用 `gns.confidence` 加權投票，挑戰者要連續領先 0.4 秒
且平均信心差 ≥ 0.05 才換手（常數以 video1.mp4 的標註擬合，692 次 → 45 次，
與標註的一致率 72% → 75%，換手中位延遲 1.1 秒）。

同一份 track 也提供 `watchedSeconds(track, t)`：各部位在 `t` 之前已播過的秒數。
覆蓋清單的標準是**固定秒數** `SEEN_SECONDS`，超過才標 seen（畫面不顯示百分比）：

| region | 秒 | region | 秒 |
|--------|----|--------|----|
| esophagus | 205 | angle | 52 |
| cardia | 51 | antrum | 98 |
| body | 217 | duodenum | 31 |

這組標準是把 video1.mp4 全部 50,455 幀跑完 GNS、經上述平滑後量到的各部位停留時間
（食道 256.0s、賁門 63.2s、胃體 271.5s、胃角 65.4s、胃竇 122.8s、十二指腸 38.9s）
取八成。因為是固定值而非「佔本片的比例」，掃描還沒跑完也能用，
碰到跳過某部位的影片也不會自動達標。`unknown` 永遠不算 seen。

**光源也走同一套平滑**：原始 modality 在 video1.mp4 上翻了 1,230 次（88 次/分鐘），
跟部位一樣不能直接顯示。`buildModalityTrack(frames)` / `trackModalityAt(track, t)`
用 1 秒視窗投票（比部位的 3 秒短——光源是人為切換的，乾淨得多，只需要去雜訊）。
部位與光源共同決定「某個模型在這一幀適不適用」，只平滑其中一個的話，這個判定
在全片仍會抖 324 次；兩個都平滑之後降到 38 次。

這一層純屬顯示，`FrameRecord` 與所有 API 皆未改變；
第二頁若也要顯示部位或光源，直接用同一組函式即可，不要另寫一份平滑。

### 4.5 IM 疊圖的顯示門檻（第一頁的規則）

GIM 是逐幀獨立判斷的，逐幀畫出來會是頻閃而不是疊圖：video1.mp4 的 16,309 個
胃部 NBI 幀裡只有 339 幀有 mask，散成 136 段，**連續段的中位長度是一幀（0.02 秒）**。

所以第一頁的 `gimFrameAt()` 加了兩層（都定義在 `protocol/lookup.ts`）：

| 常數 | 值 | 作用 |
|---|---|---|
| `IM_CONSENSUS_OF` / `IN` | 2 / 3 | GIM 跑過的最近 3 幀要有 2 幀陽性才畫 |
| `IM_CONSENSUS_WINDOW_S` | 1 | 這 3 幀最遠只往回取 1 秒 |
| `IM_HOLD_S` | 0.5 | 確認後的發現在畫面上停留多久 |

共識規則刻意跟第二頁 `reportPipeline` 的 episode 規則一致，兩頁對「一個發現」的
認定才會相同。實測：出現次數 30 → 16 次，被拿掉的正是那些單幀閃光。

停留時間刻意維持在 0.5 秒。拉長確實會讓畫面更穩（1.5 秒時是 11 次、中位 1.85 秒），
但那是用「輪廓殘留在鏡頭已經移開的黏膜上」換來的——**畫錯位置的輪廓比短暫的輪廓更糟**。
真正讓疊圖穩下來的是共識，不是停留。

### 4.2 GIM 的適用範圍

GIM 是在**胃部黏膜的 NBI 影像**上訓練的。食道與十二指腸不在它的定義域內
（在那裡輸出 mask，等於對一個沒問過的問題給出很有把握的答案），所以：

```
gim 可跑  ⇔  modality == 'NBI'  且  region ∈ { cardia, body, angle, antrum }
```

定義於 `protocol/types.ts` 的 `GIM_REGIONS` / `gimApplies()`。
**這是第一頁的規則，比 gateway 嚴格**：gateway 自己只看 NBI，背景掃描仍會對食道與
十二指腸的 NBI 幀跑 GIM，`FrameRecord.gim` 在那些幀上也可能有值。第一頁兩件事都照
這條規則走——不向 `/analyze` 要那些幀的 mask，也不顯示既有的：IM overlay 按鈕停用、
不疊圖。第二頁若要顯示 mask，請自行套同一條規則。

mask 一律畫成**只有邊框的輪廓**，中間不上色——病灶內部的 pit pattern 正是判讀的
依據，蓋掉就沒得看了。描邊由 `components/MaskBoundaryFilter.tsx` 這個共用的
SVG filter 負責，live 與 report 共用，IM 與息肉也共用（顏色取自 mask 自己）。

### 4.3 息肉（POLYP）的適用範圍與觸發方式

這是兩個模型串起來的一條管線：

```
偵測器 (YOLO, fine-tune 於浙江大學胃鏡資料集)  →  bounding box
                                                   ↓
MedSAM (vit_b, box prompt)                     →  mask
```

偵測器只在**白光的胃部影像**上訓練過，所以：

```
polyp 可跑  ⇔  modality == 'WL'  且  region ∈ { cardia, body, angle, antrum }
```

定義於 `protocol/types.ts` 的 `POLYP_REGIONS` / `polypApplies()`，
gateway 端的鏡像在 `backend/protocol.py` 的 `POLYP_REGIONS`。
**與 GIM 不同的是，這條規則 gateway 自己也會強制執行**：不適用的幀即使
`polyp: true` 也一律回傳 `polyp: null`，不會浪費 GPU。

**它不在背景掃描裡。** GNS 與 GIM 是全片跑完寫進 session 的，息肉不是：
一幀約 90–120 ms（MedSAM 的 ViT-B encoder 是主要成本），全片五萬幀跑不動。
所以 `FrameRecord.polyp` 的預設值永遠是 `null`，**只有在有人明確
用 `POST /analyze` 帶 `polyp: true` 要過之後才會有值**。要過的結果一樣會寫回
session、一樣會用 `frames` 事件廣播，所以兩個頁面看到的是同一份東西。

### 4.4 mask 的形狀是後端決定的

送到前端的 mask 已經是**可以直接描邊的形狀**，處理在 `backend/masks.py`，
兩支服務寫檔前各跑一次：

| 步驟 | IM | 息肉 |
|---|---|---|
| 平滑（σ=9，模糊後重新取門檻） | ✓ | ✓ |
| 合併相鄰斑塊（半徑 60） | ✓ | ✗ |
| 填掉內部空洞 | ✓ | ✓ |

順序不能換：合併是把斑塊撐大到彼此接觸，兩隻手臂接起來就會把中間圍成一個新的洞，
所以**填洞一定要放在最後**。實測 200 張 IM mask，這個順序殘留 0 個洞。

IM 會合併是因為它是瀰漫性的，模型吐出來的是同一片病灶的碎塊（典型一幀 213 塊、
366 個洞），逐塊描邊等於在描雜訊；息肉是離散病灶而且畫面上要報數量，
兩顆靠得近的息肉必須維持兩個輪廓。

**為什麼不在瀏覽器做**：填洞是全域運算，SVG filter 只有局部運算，做不到；
而且 filter 的半徑單位是 CSS 像素，同一張 mask 在 report 的縮圖和 live 的大畫面上
會被算成不同形狀。改在後端以 ROI 像素處理之後，兩邊終於一致。

早於這個改動掃描的 session，mask 還是舊的形狀，用
`python scripts/reshape_masks.py` 就地重寫。

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

### `DELETE /api/sessions/{id}`
刪除 session：記憶體裡的紀錄與磁碟上的整個資料夾（frames 是大宗，
14 分鐘 60fps 約 4 GB）。回傳 `{ "deleted": "<id>" }`。

- **不可復原**，第一頁的按鈕會先要求確認一次。
- 還在處理中的 session 會**先被停下來**：pipeline task 取消、ffmpeg kill，
  否則兩者都還會繼續往資料夾裡寫（`Session.save()` 會把它重建出來），
  留下一個半殘的 session。

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
{ "t": 692.75, "polyp": false }   // polyp 可省略，預設 false
// response：一筆 FrameRecord
```

用途是第一頁的即時判讀：影片播到或跳到掃描還沒覆蓋的位置時，就地推一幀。

- **補齊該幀缺的東西**：GNS、GIM，或兩者。背景掃描是 GNS 全片跑完才開始跑 GIM，
  所以一個 session 大部分時間裡，playhead 底下的幀有部位卻還沒有 mask；
  這支 API 是 GIM pass 到達之前唯一能把 mask 疊上畫面的路徑。
- **`polyp: true` 才會跑息肉管線**（偵測 + MedSAM，見 §4.3）。省略或 `false`
  時 `FrameRecord.polyp` 一定是 `null`——沒有任何背景流程會去填它。
  不適用的幀（NBI、食道、十二指腸）即使要了也回 `null`。
- **冪等**。該幀若已算齊（WL 幀有 GNS 即算齊，GIM 只在 NBI 上跑），
  直接回傳既有結果，不會重算。息肉同理：算過一次就存著，再要也不重算。
- 結果會**寫回 session**，所以背景掃描之後會跳過它，第二頁拿到的與第一頁顯示的完全一致。
- 同時也會用 `frames` 事件廣播出去。
- 該幀若還沒被抽出來，gateway 會用 ffmpeg 單幀 seek 補（約 200ms，與時間點深淺無關）；
  已抽出來的話就只是讀檔，整體約 25–30ms。
  **帶 `polyp: true` 時**：偵測不到東西約 +15ms，偵測到而要跑 MedSAM 約 **90–120ms**。
- 伺服器端一次只跑一個隨選推論。呼叫端應自行做 single-flight，不要塞滿佇列。
  息肉要整段掃的話請自行節流，不要用 30Hz 去打。

> **模型服務一次只服務一個請求。** GIM 與 POLYP 的 `/predict` 內部有互斥鎖：
> 它們的端點是同步 `def`，FastAPI 會丟進執行緒池，兩條執行緒進入同一個模型
> 並不安全，而且不會報錯——實測併發 2 就會讓服務永久卡死（一條執行緒釘在
> GPU 上不返回，`/health` 卻照常回應）。呼叫端不需要自己協調，但要知道
> 請求會排隊；等不到會回 **503**，而不是無限等待。

### `GET /api/sessions/{id}/fhir`
把這次檢查匯出成 HL7 FHIR R4 的 collection Bundle。

```
GET /api/sessions/{id}/fhir?patient=Patient/12345
```

`patient` 必填，且**不會被儲存**——本系統不持有病患資料，subject 由呼叫端指定。
詳見 [`FHIR.md`](FHIR.md)。

### `GET /api/sessions/{id}/events`
SSE，見 §3.3。連線建立時會先補送一次當下的 `status` 與 `progress`。

### `GET /api/videos`
列出後端 `VIDEO_DIR` 底下可用的影片，供第一頁選片。

```jsonc
{ "videos": [ { "path": "...", "filename": "video1.mp4", "size_bytes": 2503119646 } ] }
```

### `POST /api/videos/uploads` → `PUT …/{id}` → `POST …/{id}/complete`
分塊上傳，**前端用的是這條路**。

```jsonc
// 1. 開啟（或續傳）
POST /api/videos/uploads
{ "filename": "video1.mp4", "size_bytes": 2503119646 }
-> { "upload_id": "…", "received_bytes": 0, "size_bytes": 2503119646 }

// 2. 依序附加，每次一塊（body 是原始位元組，不是 multipart）
PUT /api/videos/uploads/{upload_id}
-> { "upload_id": "…", "received_bytes": 8388608, "size_bytes": 2503119646 }

// 3. 完成，檔案移進 VIDEO_DIR
POST /api/videos/uploads/{upload_id}/complete
-> VideoFile

// 放棄
DELETE /api/videos/uploads/{upload_id}
```

**為什麼要分塊**：單一個幾 GB 的 POST 不是每條路徑都過得去。VS Code dev tunnel
前面有一層 nginx，`client_max_body_size` 會在邊緣就回 413，gateway 根本收不到
請求，也就無從回報。分塊之後每個請求都夠小。

**續傳**：`upload_id` 由「檔名 + 長度」推導，所以同一個檔案重新開啟會回報
已收到的位元組數，從那裡接續即可。重新整理頁面再選同一個檔案就會續傳。
前端遇到 413 會自動把塊大小減半重試（8 MB 起，下限 256 KB）。

**限制**：`received_bytes` 超過宣告長度回 422；未傳完就 complete 回 409；
副檔名限 `.mp4 .avi .mov .mkv`，其餘回 400。檔名只取 basename
（不可能寫到 `VIDEO_DIR` 之外），同名自動加 `-1`、`-2` 後綴。
未完成的上傳留在 `VIDEO_DIR/.uploads/`，**目前沒有自動清理**。

### `POST /api/videos`
`multipart/form-data`，欄位名 `file`，一次送完。保留給本機腳本與 curl 使用——
經過反向代理時很可能被擋（見上），所以瀏覽器端不走這條。
同樣以 4MB 分塊寫入磁碟，不會把整支影片讀進記憶體。

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

### 6.1 要息肉結果的話：調用方法

`ready` 之後 `frames` 裡的 `polyp` **全部都是 `null`**，這是預期行為，不是漏算
（§4.3）。第二頁要用的話，自己挑時間點去要，第一頁不會替你要。

```ts
import { analyzeFrame, polypApplies, frameAt, getFrames } from '@/protocol'

const frames = await getFrames(sessionId)

// 1. 先用 polypApplies 篩掉跑不了的幀，別把不適用的時間點丟進去——
//    gateway 會回 null，只是白跑一趟。
const candidates = frames.filter((f) => polypApplies(f.gns))

// 2. 自己決定要看哪些時間點。整片每幀都要是不切實際的：
//    一幀 90–120ms，五萬幀等於一個半小時。下面是每 2 秒取一幀的例子。
const STEP_S = 2
const wanted: number[] = []
for (const f of candidates) {
  if (wanted.length === 0 || f.t - wanted[wanted.length - 1] >= STEP_S) {
    wanted.push(f.t)
  }
}

// 3. 串列送，不要並發。伺服器端一次只跑一個隨選推論，塞爆佇列只會讓
//    第一頁的即時判讀跟著卡住。
const found = []
for (const t of wanted) {
  const frame = await analyzeFrame(sessionId, t, { polyp: true })
  if (frame.polyp?.boxes.length) found.push(frame)
}
```

拿到的 `frame.polyp` 就是 §3.2 的 `PolypResult`：

- `boxes` — 偵測框，**ROI 像素座標**，跟 `image_url` 的 JPEG 同一個座標系，
  可以直接畫在上面。
- `mask_url` — RGBA PNG，ROI 尺寸，已經上好黃色。想跟第一頁一樣做成描邊的話，
  照抄 `ScopeStage.tsx` 的 `MaskBoundaryFilter`（那是一個純 SVG filter，
  沒有相依，複製過去即可——**不要 import**，§6 第 1 條）。
- `area` — mask 佔 ROI 的百分比。

要點：

- 結果會寫回 session，所以**要過一次之後就一直在**，重整頁面、換人看都還在，
  也會出現在後續的 `getFrames()` 裡。不必自己做快取。
- 同一個時間點要第二次不會重算，直接回既有結果。
- 沒偵測到時 `polyp` 是 `{ boxes: [], area: 0, mask_url: null }`，
  **不是 `null`**——`null` 代表「沒人問過」，空陣列代表「問過了，沒有」。
  這兩者要分開處理，否則會一直重複去要同一批空幀。

---

## 7. 已知限制

- GNS 全片區域準確率約 80%（video1）/ 60%（video2），插入段、十二指腸、
  賁門最弱。這是模型上限。
- GIM 只在**胃部**的 NBI 影像上訓練；白光、食道、十二指腸的輸出無意義，因此被硬性關閉（§4.2）。
- `G1–G6` 的解剖對應是經驗推得，非論文記載。
- 息肉偵測器是**自己訓練的**，不是現成權重：上游專案（kojix2/Gastric-polyps-detection）
  只附標註不附模型，它 README 給的預訓練 ONNX 連結已失效。目前這顆是拿它的
  404 張標註影像（另有 354 張上下翻轉的擴增）fine-tune 出來的，
  在 81 張未見過的影像上 mAP50 0.785 / mAP50-95 0.433。
  資料集來自浙江大學的另一台胃鏡主機，與本專案的 GIF-H290 影像條件不同，
  **誤報率會比上面那個數字給人的印象高**，這是它最主要的限制。
- MedSAM 是**通用**醫學影像分割模型，沒有針對胃息肉微調過。它只負責把框變成輪廓，
  框錯了它會很有信心地把錯的東西描出來——輪廓的品質不能反過來當作偵測正確的證據。
