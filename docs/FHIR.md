# HL7 FHIR 匯出

> 把一次檢查的模型結果匯出成 **FHIR R4（4.0.1）collection Bundle**，
> 供院內系統接收。

```
GET /api/sessions/{id}/fhir?patient=Patient/12345
```

`patient` **必填**，且**不會被儲存**。

---

## 1. 為什麼 subject 要由呼叫端帶入

本系統**不持有任何病患資料**，而且是刻意的：ROI 裁切的目的之一就是裁掉主機畫面
左欄的病歷號與生日（見 [`PROTOCOL.md`](PROTOCOL.md) §2）。`SessionManifest`
裡只有 session id、影片檔名、ROI、取樣率與進度。

但 FHIR 的臨床資源（`Observation`、`DiagnosticReport`、`ImagingStudy`）都要求
`subject`。三種解法裡採用的是**由呼叫端帶入 reference**：

- 本系統維持不進入 PHI 的規管範圍（不需加密儲存、存取控制、稽核軌跡）
- 產出的 Bundle 直接帶有院內系統認得的 `Patient/…` 參照，不需要二次對應
- 那個字串只存在於這一次請求與回應之中，不寫入 session、不寫入 log

---

## 2. 資源對應

| 本系統的東西 | FHIR 資源 | 說明 |
|---|---|---|
| 一次 session | `ImagingStudy` | 影片檔名、ROI、取樣率記在 `note`；`numberOfInstances` = 抽出的幀數 |
| 五個 AI 模型 | `Device` × 3 | `version` 用**權重檔名**——那才是真正決定輸出的東西，可對照 [`IEC62304.md`](IEC62304.md) §5 的 SOUP 清單 |
| 部位停留時間 | `Observation` (`site-coverage`) | 每個部位一個 `component`，單位秒 |
| IM 發現 | `Observation` (`gastric-intestinal-metaplasia`) | **一個 episode 一筆**，非逐幀。`valueInteger` = 峰值 score，`component` 帶峰值面積、持續秒數、影片時間位置 |
| 息肉發現 | `Observation` (`gastric-polyp`) | `valueInteger` = 該幀偵測到的顆數，`component` 帶面積、偵測器信心、時間位置 |
| 整體結論 | `DiagnosticReport` | `result` 參照上述所有 Observation，`status` 恆為 `preliminary` |

**沒有匯出的東西：**

- **CGI（胃體為主胃炎）**——它的結果不存在 session 裡。第二頁是直接呼叫
  `/api/cgi/predict` 並自行保存，後端沒有留存，所以匯出拿不到。
- **mask 圖檔**——目前只在 Bundle 外以 `/files/...` 提供。要納入的話應以
  `Media` 或 `DocumentReference` 表示。

---

## 3. 代碼：目前全部是本專案自訂的

**所有 `code` 與 `bodySite` 都使用本專案自己的 CodeSystem URI，不是 SNOMED CT
或 LOINC。**

```
https://github.com/hook123152828/EsophagoGastroDuodenoscopy/CodeSystem/observation
https://github.com/hook123152828/EsophagoGastroDuodenoscopy/CodeSystem/body-site
```

這是刻意的，也是**尚未完成的工作**。綁定標準術語集必須由能逐一核對概念的人來做：
一個看起來合理但實際錯誤的 SNOMED 代碼，比一個明顯是自訂的代碼危險得多——
`bodySite` 指到錯的器官，會被下游系統當成事實。

要真正互通，這一步必須完成。

---

## 4. 時間的表示方式

Observation **沒有 `effectiveDateTime`**。

資料裡沒有這支影片實際錄製的時間，捏造一個時間戳等於在臨床發現上放一個假的
時間。因此時間位置以 `component` 表示：

```jsonc
{
  "code": { "text": "Offset into the recording" },
  "valueQuantity": { "value": 646.17, "unit": "s", "system": "http://unitsofmeasure.org", "code": "s" }
}
```

`ImagingStudy.started` 與 `DiagnosticReport.issued` 用的是 **session 建立時間**，
不是檢查時間。

---

## 5. IM episode 的認定規則

匯出不會逐幀輸出——GIM 是逐幀獨立判斷的，單幀輸出極不穩定（見
[`PROTOCOL.md`](PROTOCOL.md) §4.5）。一個 episode 的成立條件：

1. 最近 3 個 GIM 跑過的幀中，至少 2 幀為陽性，取樣範圍不超過 1 秒
2. 部位必須在胃部（`GIM_REGIONS`）——**在食道或十二指腸的結果不會被匯出**，
   即使舊 session 的資料裡有。模型未在那些部位訓練過
3. 相隔 2 秒以內的確認幀視為同一個 episode

> 這條共識規則目前存在**三份實作**：`backend/fhir.py`、
> `frontend/src/protocol/lookup.ts`、`frontend/src/pages/report/reportPipeline.ts`。
> 這是已知的維護成本——其中一份改動時，另外兩份必須跟著改。

---

## 6. 為什麼 status 永遠是 preliminary

`DiagnosticReport.status` 與各發現的 `Observation.status` 固定為 `preliminary`。

FHIR 沒有「機器產生、尚未經人審閱」這個狀態。`final` 意味著結果已經確定並可被
採信，而這裡的每一筆都只是模型輸出。在有臨床醫師簽署的流程建立之前，
`preliminary` 是唯一誠實的選擇。

`DiagnosticReport.conclusion` 也明文寫出這一點。

---

## 7. 已知限制

1. 代碼未綁定標準術語集（§3）——**這是互通性的主要缺口**
2. CGI 結果無法匯出（§2）
3. mask 影像未納入 Bundle（§2）
4. 未提供 FHIR RESTful API（search / read / create），只有單向匯出
5. 未針對任何 Implementation Guide（如 IHE 的內視鏡相關 profile）做 profiling
6. Bundle 型別為 `collection`。要 POST 進 FHIR server 的話需改為 `transaction`
   並為每個 entry 加上 `request`
