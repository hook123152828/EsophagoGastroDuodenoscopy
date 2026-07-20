# Multi-Module Project (GNS / GIM / CGI)

本專案包含三個主要模組：**GNS**、**GIM** 與 **CGI**。以下為各模組的環境建置、資料集準備與執行說明。

---

## 📋 目錄
1. [GNS 模組](#gns-module)
   - [環境安裝](#gns-env)
   - [資料集目錄結構與設定](#gns-dataset)
   - [執行指令](#gns-exec)
   - [權重路徑設定](#gns-weights)
2. [GIM 模組](#gim-module)
   - [環境安裝](#gim-env)
3. [CGI 模組](#cgi-module)
   - [環境安裝](#cgi-env)

---

## 🚀 GNS 模組 <a id="gns-module"></a>

### 🛠️ 環境安裝 <a id="gns-env"></a>

請使用 `conda` 與 `pip` 安裝指定版本的 PyTorch、NATTEN 及相關依賴套件。建議在具備 GPU 的環境下執行：

```bash
conda create -n [env_name] python=3.8

# 1. 安裝 PyTorch 核心環境與 CUDA 工具包
conda install pytorch==1.11.0 torchvision==0.12.0 cudatoolkit=11.3 -c pytorch -y

# 2. 安裝 NATTEN、timm 及其他核心依賴套件
pip install https://www.shi-labs.com/natten/wheels/cu113/torch1.11/natten-0.14.4%2Btorch1110cu113-cp38-cp38-linux_x86_64.whl git+https://github.com/rwightman/pytorch-image-models.git@9d6aad44f8fd32e89e5cca503efe3ada5071cc2a fvcore==0.1.5.post20220305 pyyaml==6.0 "numpy<2.0.0" --trusted-host www.shi-labs.com


# 3. 安裝其他影像處理與數據分析套件
pip install opencv-python pandas
```

### 📂 資料集目錄結構與設定 <a id="gns-dataset"></a>

專案支援多中心或單一資料集的讀取，標準的目錄階層配置如下：
資料夾位置:
🔗 [資料集位置:](https://140.113.210.83:5001/#/signin)

```text
dataset/
├── train/
│   └── hospital_name/
│       └── class_name/
│           └── 1.png
└── test/
    └── hospital_name/
        └── class_name/
            └── 1.png
```

#### 資料集準備方案（三選一）：
1. **新資料放法一**：直接依據圖片的類別（Class），分類放入 `train` 或 `test` 底下的 `hospital_name/class_name` 資料夾。
2. **新資料放法二**：可先建立個別的醫院資料夾 `hospital_name`，再於內部根據類別建立子資料夾置放圖片。
3. **自定義資料集**：可以自行撰寫 Dataset 程式碼，修改資料讀取邏輯以符合您現有的資料架構。

#### 內建 Dataloader 與參數設定
本專案已**內建編寫好的私人與公開資料集 Dataloader**，使用時請注意以下設定：
- **路徑確認**：在開始執行前，請先確認 Dataloader 內部的讀取路徑。預設狀況下，系統皆會前往根目錄底下的 `dataset/` 資料夾內讀取對應的資料。
- **參數修改**：請至程式碼中尋找並修改 `DATASET` 參數，以切換至您想使用的資料集目標。例如：

```python
# 根據需求更換為指定的內建資料集名稱
DATASET = "AIGNS"
# DATASET = "GastroHUN"
```

### 💻 執行指令 <a id="gns-exec"></a>

#### 1. 模型訓練 (Training)
執行以下指令開始訓練模型：

```bash
python main.py --mode train
```

#### 2. 模型評估 (Evaluation / Inference)
使用測試集進行模型效能與指標評估：

```bash
python main.py --mode evaluate
```

#### 3. 單張圖片預測 (Prediction)
將需要進行單張推論的圖片放入 `data/` 資料夾中，並執行：

```bash
python main.py --mode predict
```

### 💾 權重路徑設定 <a id="gns-weights"></a>

執行相關腳本前，請先至 `main.py` 中手動確認或修改以下權重路徑：

- **訓練階段（儲存最佳權重）**：
  模型訓練過程中，最佳權重的儲存路徑由 `main.py` 內部的 `best_path` 變數定義：

  ```python
  best_path = "path/to/save/best_model.pth"
  ```

- **測試與預測階段（載入權重）**：
  進行評估或單張預測時，載入的模型權重路徑由 `main.py` 內部的 `load_path` 變數定義：

  ```python
  load_path = "path/to/load/checkpoint.pth"
  ```

---

## 🌐 GIM 模組 <a id="gim-module"></a>

### 🛠️ 環境安裝 <a id="gim-env"></a>

GIM 模組涉及網頁系統或平台的建置，詳細環境依賴與安裝步驟，請直接參考以下專案連結的說明：
🔗 [CIS_IM_Website GitHub 專案頁面](https://github.com/chenyuting3077/CIS_IM_Website?tab=readme-ov-file)

### 💻 測試

```bash
python test.py
```

---

## ⚙️ CGI 模組 <a id="cgi-module"></a>

### 🛠️ 環境安裝 <a id="cgi-env"></a>

本模組的依賴環境較為彈性，請依據執行時系統提示的缺少套件進行動態安裝。
> 💡缺啥裝啥 by 峻逢學長

### 💻 測試

```bash
python test.py
```