import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countSms, extractPlaceholders, insertAt, toDltText } from './sms.ts';

test('GSM single part up to 160, then 153 per part', () => {
  assert.deepEqual(
    { ...countSms(''), unicodeChars: undefined },
    { encoding: 'GSM-7', units: 0, chars: 0, parts: 0, perPart: 160, remaining: 160, unicodeChars: undefined },
  );
  const c160 = countSms('a'.repeat(160));
  assert.equal(c160.parts, 1);
  assert.equal(c160.remaining, 0);
  const c161 = countSms('a'.repeat(161));
  assert.equal(c161.parts, 2);
  assert.equal(c161.perPart, 153);
  assert.equal(c161.remaining, 306 - 161);
  assert.equal(countSms('a'.repeat(306)).parts, 2);
  assert.equal(countSms('a'.repeat(307)).parts, 3);
});

test('GSM extended characters count double', () => {
  const c = countSms('Price: 10€ [ok]');
  assert.equal(c.encoding, 'GSM-7');
  assert.equal(c.chars, 15);
  assert.equal(c.units, 18);
  assert.equal(countSms('{'.repeat(80)).parts, 1); // 160 septets
  assert.equal(countSms('{'.repeat(81)).parts, 2);
});

test('escape pairs are not split across concatenated parts', () => {
  // 152 plain + one extended (2 septets) = 154 > 153 so the euro moves to part 2; plus 153 more plain → 3 parts.
  const text = 'a'.repeat(152) + '€' + 'a'.repeat(152);
  assert.equal(countSms(text).units, 306);
  assert.equal(countSms(text).parts, 3);
});

test('GSM basic accented letters stay 7-bit', () => {
  const c = countSms('Café à Zürich ñ £5 @home');
  assert.equal(c.encoding, 'GSM-7');
  assert.equal(c.units, c.chars);
});

test('Unicode: 70 single, 67 per part, UTF-16 units', () => {
  const tamil = 'வணக்கம்'; // 7 code units
  const c = countSms(tamil);
  assert.equal(c.encoding, 'UNICODE');
  assert.equal(c.units, 7);
  assert.equal(c.parts, 1);
  assert.ok(c.unicodeChars.length > 0);
  assert.equal(countSms('அ'.repeat(70)).parts, 1);
  assert.equal(countSms('अ'.repeat(71)).parts, 2);
  assert.equal(countSms('अ'.repeat(134)).parts, 2);
  assert.equal(countSms('अ'.repeat(135)).parts, 3);
  // One non-GSM char flips the whole message (curly quote)
  const mixed = countSms('a'.repeat(100) + '’');
  assert.equal(mixed.encoding, 'UNICODE');
  assert.equal(mixed.parts, 2);
  // Emoji are surrogate pairs = 2 units
  const emoji = countSms('🚨');
  assert.equal(emoji.units, 2);
  assert.equal(emoji.chars, 1);
  assert.deepEqual(emoji.unicodeChars, ['🚨']);
});

test('DLT text and placeholders', () => {
  const body = 'Alert: {{vehicle_name}} at {{ speed }} km/h near {{location}}. {{vehicle_name}}';
  assert.deepEqual(toDltText(body), {
    text: 'Alert: {#var#} at {#var#} km/h near {#var#}. {#var#}',
    variables: ['vehicle_name', 'speed', 'location', 'vehicle_name'],
  });
  assert.deepEqual(extractPlaceholders(body), ['vehicle_name', 'speed', 'location']);
});

test('insertAt replaces the selection and returns the caret', () => {
  assert.deepEqual(insertAt('Hello world', 6, 11, '{{plate}}'), { value: 'Hello {{plate}}', caret: 15 });
  assert.deepEqual(insertAt('abc', 99, 99, 'X'), { value: 'abcX', caret: 4 });
  assert.deepEqual(insertAt('abc', 0, 0, 'X'), { value: 'Xabc', caret: 1 });
});
