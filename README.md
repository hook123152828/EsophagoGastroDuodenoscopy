# 上消化道內視鏡 AI 主控台

把一支內視鏡檢查影片餵進三個 AI 模型，即時顯示目前檢查部位、疊上腸上皮化生
（IM）分割結果，並把逐幀分析結果交給下游流程產生報告。

判讀不需要等待：影片一載入就能邊播邊判，畫面跑到背景掃描還沒走到的地方時，
系統會就地推論當下那一幀（約 25–30 ms）。

| 模型 | 用途 | 說明 |
|------|------|------|
| **GNS** (SGAFormer) | 解剖部位分類 | 16 類（食道／胃 G1–G6／十二指腸 × WL·NBI） |
| **GIM** (Mask Focal Modulation Network) | IM 分割 | Mask2Former + FocalNet，**只在 NBI 影像上有效** |
| **CGI** (GSCNet) | 胃體為主胃炎判別 | 吃三張白光影像（胃竇／胃體／賁門） |

前端有兩個獨立開發的頁面，中間只有一層固定契約：

- **`/live`** — 即時檢視：上傳／選片、播放、即時部位判讀、IM 疊圖開關、時間軸
- **`/report`** — 報告：訂閱掃描完成事件後接手下游流程（**目前是空殼**）

契約規格見 **[`docs/PROTOCOL.md`](docs/PROTOCOL.md)**。要開發 `/report` 的人請先讀它。

---

## 系統需求

- NVIDIA GPU（開發驗證於 **RTX 4090 / 24GB**，CUDA 11.8 驅動）
- Linux
- `conda`（Miniconda 或 Anaconda）
- `ffmpeg` 與 `ffprobe`
- Node.js 20+

三個模型的相依版本互不相容（torch 1.11 / 2.0 / 2.0），所以**各跑在自己的 conda
環境**，透過 HTTP 溝通。這是刻意的設計，不要嘗試合併成一個環境。

---

## 一、取得外部模型專案與權重

三個模型專案**不在本 repo 內**（權重合計超過 3GB，遠超 GitHub 檔案上限）。
請另行取得後放到以下位置：

```
code/
├── GNS/
│   ├── nat.py, dataloader.py, module/ ...
│   └── weights/best_94.0050_AIGNS.pth          (681 MB)
├── GIM/
│   ├── mmsegmentation-main/                     (版本綁死的原始碼樹，要 editable 安裝)
│   ├── mmdetection/                             (同上)
│   └── model/
│       ├── mask2former_FocalNet_tiny_50_IM_Aug_focal_decoder.py
│       └── epoch_50_bd.pth                      (629 MB)
└── CGI/
    ├── CGI_model.py, Network/, utils/
    └── weight/Paper_95.74_93.75_96.15_98.36.pth (443 MB)
```

放在別的地方也可以，用環境變數指定即可（見下方「設定」）。
**這些專案是唯讀相依，本系統不會修改它們任何一個檔案。**

檢查影片放在 `video/`：

```
code/video/video1.mp4
```

---

## 二、建立四個 conda 環境

`envs/*.requirements.txt` 是開發機上實際可運作的完整版本清單，可作為對照。
以下是最小可運作的安裝步驟。

### GNS（torch 1.11 + natten）

`natten` 必須用對應 torch/CUDA 版本的預編譯 wheel，**這是整套裡最容易卡住的一步**。

```bash
conda create -y -n GNS python=3.8
conda activate GNS
pip install torch==1.11.0+cu113 torchvision==0.12.0+cu113 \
    --extra-index-url https://download.pytorch.org/whl/cu113
pip install https://www.shi-labs.com/natten/wheels/cu113/torch1.11/natten-0.14.4%2Btorch1110cu113-cp38-cp38-linux_x86_64.whl
pip install timm==0.6.13 fastapi uvicorn pillow "numpy<2"
```

### GIM（torch 2.0.1 + mmsegmentation）

`mmsegmentation` 與 `mmdetection` **要從 GIM 專案內附的原始碼樹安裝**（它們的版本
與 config 綁死，pip 上的版本裝了不一定能載入這個 checkpoint）：

```bash
conda create -y -n IM_web python=3.8
conda activate IM_web
pip install torch==2.0.1 torchvision==0.15.2 --index-url https://download.pytorch.org/whl/cu118
pip install -U openmim
mim install mmengine==0.10.7 "mmcv==2.0.0"

# 從 GIM 專案內附的原始碼安裝（editable）
pip install -e GIM/mmsegmentation-main    # mmseg 1.1.2
pip install -e GIM/mmdetection            # mmdet 3.2.0

pip install fastapi uvicorn pillow "numpy<2" timm
```

> GIM 的 config 會 `import mmdet.models`，所以 `mmdet` 是必要的，不能只裝 mmseg。

### CGI（torch 2.0.1）

```bash
conda create -y -n cgi_env python=3.10
conda activate cgi_env
pip install torch==2.0.1 torchvision==0.15.2 --index-url https://download.pytorch.org/whl/cu118
pip install fastapi uvicorn pillow "numpy<2"
```

### Gateway（純 CPU，不需要 torch）

```bash
conda create -y -n endo-gateway python=3.11
conda activate endo-gateway
pip install fastapi uvicorn httpx pydantic python-multipart
```

> `python-multipart` 是影片上傳需要的，少了它 `POST /api/videos` 會失敗。

### 前端

```bash
cd frontend && npm install
```

---

## 三、啟動

```bash
bash scripts/start_services.sh     # 四支服務，log 在 logs/
cd frontend && npm run dev         # http://localhost:5173
```

`start_services.sh` 會等模型載入完成並印出健康狀態，應該看到：

```json
{"gateway":true,"gns":true,"gim":true,"cgi":true}
```

關閉：

```bash
bash scripts/stop_services.sh
```

### 使用

1. 開 <http://localhost:5173> → 選一支影片，或把影片拖進上傳區
   （存進 `VIDEO_DIR`，上傳完成即自動建立 session 並進入檢視頁）
2. 背景會依序執行：ffmpeg 裁切抽幀 → GNS 全片分類 → GIM 對 NBI 幀分割，
   每算完一批就即時推送到畫面上
3. **不必等掃描完成**。播放或拖到掃描還沒走到的位置時，第一頁會就地送那一幀去
   推論，控制列出現 `LIVE` 標記與當次延遲。結果會寫回 session，
   背景掃描之後會跳過它
4. 掃描完成後 session 轉為 `ready`，`/report` 頁會自動收到事件並接手

實測 `video1.mp4`（14 分鐘 / 60 fps / 2.5 GB）在 RTX 4090 上：

| 取樣設定 | 幀數 | 全片掃描 | session 大小 |
|---|---|---|---|
| `15 / 15 / 5` | 12,614 | 4.6 分 | 1.0 GB |
| `60 / 60 / 60`（目前預設） | 50,455 | 約 27 分 | 約 4.0 GB |

隨選推論的延遲與取樣設定無關：

| 情況 | 延遲 |
|---|---|
| 該幀已抽出（抽幀完成後的常態） | **25–30 ms** |
| 該幀還沒抽到，需 ffmpeg 單幀 seek | 190–300 ms，與跳到影片多深處無關 |

抽幀本身很快（60 秒影片約 2.1 秒），所以第二種情況只會出現在 session 剛建立的
前幾十秒。

---

## 設定

全部透過環境變數覆寫，預設值見 [`backend/config.py`](backend/config.py)。

| 變數 | 預設 | 說明 |
|------|------|------|
| `GNS_ROOT` / `GIM_ROOT` / `CGI_ROOT` | `./GNS` `./GIM` `./CGI` | 外部模型專案位置 |
| `GNS_WEIGHT` / `GIM_WEIGHT` / `CGI_WEIGHT` | 各專案內 | 權重檔路徑 |
| `GIM_CONFIG` | `GIM/model/…focal_decoder.py` | mmseg config |
| `VIDEO_DIR` | `./video` | 影片來源目錄，也是 `/media` 串流的根 |
| `SESSION_DIR` | `./backend/sessions` | 抽出的幀、mask 與 manifest |
| `GATEWAY_PORT` | `8080` | |
| `GNS_URL` / `GIM_URL` / `CGI_URL` | `127.0.0.1:8000/8001/8002` | |
| `GNS_ENV` / `GIM_ENV` / `CGI_ENV` / `GATEWAY_ENV` | `GNS` `IM_web` `cgi_env` `endo-gateway` | 啟動腳本用的 conda 環境名 |

### 取樣率

取樣率是 per-session 的：建立 session 時可在 `POST /api/sessions` 的 `sampling`
欄位指定，未指定則用 [`backend/protocol.py`](backend/protocol.py) 的 `Sampling`
預設值，目前是 **`extract_fps=60, gns_fps=60, gim_fps=60`**。

| 參數 | 影響 |
|------|------|
| `extract_fps` | 抽幀密度。同時決定隨選推論能對到多精準的一幀（60 = 對到螢幕上那一幀） |
| `gns_fps` | 部位分類密度。設得比 `extract_fps` 高沒有意義 |
| `gim_fps` | IM 分割密度，且只作用在 NBI 幀上 |

改預設值要重啟 gateway。已經建立的 session 會保留當初的設定，不受影響。

`60/60/60` 換來的是最密的時間軸，代價是全片掃描約 27 分鐘、4 GB
（見上表）。`gim_fps` 是其中最貴而回報最低的一項——GIM 全片只在極少數幀上有
反應，而畫面上的疊圖現在也走隨選推論，不依賴掃描進度。

---

## 專案結構

```
backend/
  config.py              外部相依路徑與服務位址
  protocol.py            契約的 Python 實作（含 G1–G6 → 部位對應表、取樣預設值）
  gateway.py             :8080  上傳、抽幀、掃描排程、隨選推論、SSE、CGI 代理
  servers/
    gns_server.py        :8000  在 GNS 環境執行
    gim_server.py        :8001  在 IM_web 環境執行，回傳 ROI 座標系的 RGBA mask
    cgi_server.py        :8002  在 cgi_env 環境執行
  sessions/              每個 session 的 manifest、幀、mask（不進 git）
frontend/src/
  protocol/              ★ 兩頁唯一的共享物，契約的 TypeScript 實作
    index.ts             對外出口，兩頁都從這裡 import
    types.ts             型別與部位標籤
    client.ts            gateway 客戶端（含上傳、隨選推論、SSE 訂閱）
    geometry.ts          ROI ↔ 螢幕座標換算，疊圖對齊的唯一來源
    lookup.ts            以時間為鍵的幀查表
  pages/live/            第一頁
    LivePage.tsx         版面與播放控制
    SessionPicker.tsx    選片／既有 session 列表
    UploadPanel.tsx      影片上傳（拖放與檔案選擇）
    ScopeStage.tsx       裁切到 ROI 的畫面與 mask 疊圖
    SidePanel.tsx        部位、GNS 機率、當前幀資訊
    AnatomyMap.tsx       部位示意圖
    Timeline.tsx         部位色帶與 IM 標記
    useSession.ts        session 狀態與掃描結果串流合併
    useLiveAnalysis.ts   隨選推論（30 Hz、單飛行）
  pages/report/          第二頁（空殼）
docs/PROTOCOL.md         契約規格正本
scripts/                 啟動與停止
envs/                    各環境的完整套件版本紀錄
```

---

## 疑難排解

**`natten` 安裝失敗或 import 錯誤**
必須用對應 `torch1.11 + cu113 + python3.8` 的 wheel，用 `pip install natten`
會去編譯而通常失敗。網址見上方 GNS 安裝步驟。

**`Numpy is not available`（torch 2.0.x）**
numpy 2.x 與 torch 2.0.x 不相容，裝 `"numpy<2"`。

**`/api/health` 顯示某個模型是 `false`**
看 `logs/<name>.log`。常見原因是權重路徑不對，或該環境缺套件。
`start_services.sh` 會等每一支服務就緒，任一支啟動失敗時直接印出它的錯誤尾巴
並以非零狀態結束，不會空等。

**服務啟動後 port 被佔用、或 `stop_services.sh` 停不掉**
`start_services.sh` 每次都會先呼叫 `stop_services.sh` 清場，所以重複執行是安全的。
若曾用其他方式手動啟動過而留下孤兒，`stop_services.sh` 除了讀 `logs/*.pid`，
也會掃描 8000/8001/8002/8080 這幾個 port 並關掉還在監聽的 process。

**影片播不出來**
`<video>` 的來源是 gateway 的 `/media`，只服務 `VIDEO_DIR` 底下的檔案。
影片放在別處時 `media_url` 會是 `null`。

**疊圖沒出現**
GIM 只在 NBI 影像上訓練，白光幀的按鈕會置灰。即使是 NBI，也只有實際偵測到
IM（score ≥ 1）的幀才有 mask —— `video1.mp4` 在 `15/15/5` 設定下，2,035 個
NBI 取樣幀中只有 49 幀觸發。

**上傳影片失敗**
gateway 環境少裝 `python-multipart`。另外只接受 `.mp4 .avi .mov .mkv`，
其餘副檔名會回 400。

**部位標籤跳得很兇**
目前是逐幀獨立 argmax，沒有任何時序平滑，實測每分鐘切換約 67 次。
見「已知限制」。

**掃描很久還沒好**
正常。`60/60/60` 設定下全片約 27 分鐘。但掃描進度**不影響**畫面上的判讀——
沒掃到的位置會即時推論。掃描只決定時間軸完整度與報告頁何時能開工。

---

## 已知限制

- GNS 全片部位準確率約 80%（video1）／60%（video2），插入段、十二指腸、賁門最弱。
- **部位判讀沒有時序平滑。** 每一幀獨立取 argmax，`video1.mp4` 全片切換 946 次
  （每分鐘 67.5 次），其中 66% 的判定持續不到 0.2 秒。這不是模型準確率問題，
  是缺少遲滯造成的。要修的話只需在 `gateway.py` 掃描完 GNS 後加一層平滑，
  或在 `useLiveAnalysis` 的即時路徑上加，兩者都不會動到契約。
- 因為上一點，部位圖的「已檢視」勾選資訊量很低——六個部位在前 135 秒就全部亮完。
- GIM 訓練資料是放大內視鏡 NBI 近拍，廣角觀察畫面容易漏判。
- `G1`–`G6` 對應到哪個解剖部位在論文與程式碼中都沒有記載，目前的對應表是
  以醫師標註比對推得，定義在 `backend/protocol.py` 的 `REGION_MAP`。
