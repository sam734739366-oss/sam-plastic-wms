# عقد الإصدار 2.0.0 — مرجع إلزامي لكل تعديل

أي كود يُكتب في v2 يجب أن يلتزم بهذا الملف. إن تعارض شيء معه، فالمخطط (`src/schema.sql`) هو الحكم.

## 1. لا وجود لحالة «ملغى»

- لا عمود `status` في أي جدول مستند. `cartons.status` هو الاستثناء الوحيد، وهو حالة فيزيائية:
  `in_stock | issued | finished`.
- كل استعلامات `WHERE ... status='active'` و`status != 'void'` محظورة.
- «الإلغاء» انتهى: الحذف مادي عبر `docDelete.hardDelete`، والتعديل = ردّ الأثر القديم ثم تطبيق الجديد.

## 2. الحبة هي المرجع

- كل الكميات في القاعدة تُخزَّن حبات (`pieces`). `quantity` + `unit` مجرد طريقة إدخال.
- `items.unit_name` هو ما يظهر بدل كلمة «حبة» في الواجهة والطباعة والتقارير.
- `cartons` و`receive/bags` بيانات وصفية اختيارية للاعب؛ لا تُحسب منها الأرصدة.

## 3. أنواع المستندات و`stock_moves.doc_type`

| المستند | الجدول | `doc_type` في الحركات | كيان `audit.entity` |
|---|---|---|---|
| فاتورة شراء | `purchases` | `purchase` | `purchase` |
| تصريح صرف إنتاج | `issue_permits` | `issue` | `issue_permit` |
| **استلام الإنتاج** | `production_receipts` | `production` | `production_receipt` |
| فاتورة بيع/خردة/أجرة | `invoices` | `invoice` | `invoice` |
| تصريح خروج | `exit_permits` | `exit` | `exit_permit` |
| سند تالف | `scrap_movements` | `scrap` | `scrap` |
| نقل بين مخازن | `transfers` | `transfer` | `transfer` |
| مرتجع بيع | `sales_returns` | `sale_return` | `sale_return` |
| مرتجع شراء | `purchase_returns` | `purchase_return` | `purchase_return` |
| استلام خام عميل | `customer_raw_receipts` | (بلا حركة مخزون) | `tolling_receipt` |
| تسليم عميل | `customer_deliveries` | (بلا حركة مخزون) | `tolling_delivery` |
| دفعة نقدية | `payments` | (دفتر فقط) | `payment` |
| رصيد افتتاحي | `items` | `opening` | — |

لا يوجد `receive` بعد اليوم: استلام التام ونتيجة الإنتاج مستند واحد `production_receipts`.

## 4. استلام الإنتاج (المستند الموحّد)

`production:save(doc, userId)` يستقبل:

```js
{ id?, doc_number, doc_date, issue_permit_id, fg_item_id, warehouse_id,
  machine_id?, shift_id?, receiver_name?, notes?,
  bags?, breaks?,                       // تغليف التام بأكياس صنف الأكياس المرتبط
  cartons: [{ carton_id, good_pieces, defect_before_pieces, defect_after_pieces, notes? }] }
```

- `source` و`party_id` **يُورَثان من تصريح الصرف** ولا يُرسلان من الواجهة.
- `issued = Σ carton.pieces` للكراتين في السند، `total = Σ(slim+before+after)`،
  `variance = issued - total` (موجب ⇒ عجز يُسجَّل نصاً بلا حركة، سالب ⇒ فائض يُضاف للتام السليم).
- التوزيع: `good + surplus → salem` للصنف النهائي، `defect_after → talef` للصنف النهائي،
  `defect_before → talef` لصنف الخام الذي منه الكرتون، `bags_used → salem-` لصنف الأكياس.
- خام العميل (`issue_permits.source='customer'`): لا سلات للمصنع؛ التالف كله (`before+after`)
  يُحدِّث سند `scrap_movements` آلياً بـ `disposition='production_defect'` و`is_customer=1`
  و`prod_receipt_id`، ويُمحى مع السند (CASCADE) فيعود رصيد العميل. الأكياس تُستهلك في الحالتين.
- الأرقام المحسوبة تُخزَّن في رأس السند (`issued_pieces, good_pieces, defect_before_pieces,
  defect_after_pieces, total_pieces, variance_pieces, surplus_pieces`) ليقرأها التقرير مباشرة.

## 5. الحذف والنافذة التحذيرية

لكل مستند IPCs بنفس الشكل:

- `<e>:impact(id)` → `{ doc_number, impact: [{ code, name, bucket_label, warehouse_name, net, text }],
  value, deps: [{ label, number }], blocked }`
- `<e>:delete(id, userId)` → `{ ok, deleted, doc_number, reverted }` ويرمي خطأ `DEPENDENTS`
  برسالة عربية تذكر أرقام المستندات الأحدث عند وجود مانع.

الواجهة: كليك يمين → «حذف» تستدعي `impact` أولاً، تعرض الأثر والقيمة والموانع، ثم بعد التأكيد `delete`.
النقر المزدوج على أي صف = عرض المستند (نفس ما يفعله «عرض» في القائمة).

## 6. التقارير

سبعة تقارير: مشتريات، مصروف للإنتاج، مبيعات، إنتاج يومي، عهدة عملاء، توالف، أرصدة المخزون.
- فلاتر مشتركة: `from`/`to`، `warehouseId` (المخزن الرئيسي افتراضياً و`'all'` للتجميع)،
  `unitMode` (`pieces|carton|bag`) — الحساب دائماً بالحبة والتحويل للعرض فقط.
- **لا أعمدة وزن في التقارير إطلاقاً.**
- كل تقرير يدعم الطباعة A4 وتصدير CSV.

## 7. قواعد يجب ألا تُكسر

- التحديث التلقائي من GitHub Releases (`src/updater.js`) — لا تنزيل ذاتي بلا إذن، وكشف انقطاع التنزيل.
- النسخ الاحتياطي: محلي في `backups/` + نسخ إلى `cloud_folder` (مجلد متزامن سحابياً من الإعدادات).
  لا يوجد تكامل Google Drive OAuth في هذا المشروع؛ المجلد السحابي هو الآلية القائمة.
- المستخدمون والأدوار: `manager | clerk | viewer | warehouse`، والـ `viewer` للقراءة فقط.
- الطباعة: ترويسة/تذييل من الإعدادات تتكرر في كل صفحة فعلية.
- تهيئة القاعدة: أي قاعدة بـ `settings.schema_version < 2` تُنقل إلى `samplastic_v1_backup.db`
  (مع ‎-wal/-shm) وتُبنى قاعدة جديدة — لا حذف لملف أبداً.
