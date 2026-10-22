const test = require('node:test');
const assert = require('node:assert');
const { guideTemplate } = require('../src/print/templates');

test('guideTemplate يغلّف محتوى الدليل ويحمل اسم المصنع وحجم الورق', () => {
  const body = '<h2>قسم تجريبي</h2><ol><li>خطوة أولى</li></ol>'
    + '<div class="g-tip">تلميح</div>'
    + '<div class="g-contact"><b>للاستفسار والمراجعة التواصل مع المبرمج / سام النبهاني 775158678</b></div>';
  const html = guideTemplate({ factory_name: 'مصنع النور', report_page_size: 'A4' }, body);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('lang="ar" dir="rtl"'));
  assert.ok(html.includes('مصنع النور'));
  assert.ok(html.includes('دليل المستخدم الكامل'));
  assert.ok(html.includes('size: A4'));
  // المحتوى يمر كما هو دون تهريب (وسوم الدليل خاصة بنا)
  assert.ok(html.includes('<h2>قسم تجريبي</h2>'));
  assert.ok(html.includes('<li>خطوة أولى</li>'));
  assert.ok(html.includes('سام النبهاني 775158678'));
});

test('guideTemplate يستخدم A4 افتراضياً عند غياب الإعدادات', () => {
  const html = guideTemplate({}, '<p>نص</p>');
  assert.ok(html.includes('size: A4'));
  assert.ok(html.includes('سام بلاستيك'));
});
