const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const { parse } = require('@babel/parser');

const root = path.join(__dirname, '..');
const file = path.join(root, 'src/components/FingerSelector.jsx');
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = module.paths;
loaded._compile(buildSync({ entryPoints: [file], bundle: true, write: false, format: 'cjs',
  platform: 'node', packages: 'external', jsx: 'automatic' }).outputFiles[0].text, file);
const { default: FingerSelector, FINGER_NAMES } = loaded.exports;
const render = props => renderToStaticMarkup(React.createElement(FingerSelector, { value: '', onChange() {}, ...props }));
const inputs = html => [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]);

test('visual fingers preserve all ten original ZK slots and accessible names', () => {
  assert.deepEqual(FINGER_NAMES, ['Meñique izquierdo', 'Anular izquierdo', 'Medio izquierdo', 'Índice izquierdo', 'Pulgar izquierdo',
    'Pulgar derecho', 'Índice derecho', 'Medio derecho', 'Anular derecho', 'Meñique derecho']);
  const options = inputs(render());
  assert.equal(options.length, 10);
  options.forEach((input, index) => {
    assert.ok(input.includes(`value="${index}"`));
    assert.ok(input.includes(`aria-label="${FINGER_NAMES[index]}"`));
    assert.match(input, /type="radio"/);
    assert.doesNotMatch(input, /checked=/);
  });
  assert.equal(new Set(options.map(input => input.match(/name="([^"]+)"/)[1])).size, 1);
});

test('only occupied fingers are disabled and carry a registered state, not just color', () => {
  const html = render({ occupiedSlots: [0, 4, 9] });
  inputs(html).forEach((input, index) => {
    assert.equal(input.includes('disabled=""'), [0, 4, 9].includes(index));
    assert.equal(input.includes('(registrado)'), [0, 4, 9].includes(index));
  });
  assert.equal((html.match(/finger-hand-digit is-registered/g) || []).length, 3);
});

test('one selection is reflected in the diagram, radio state and live finger name', () => {
  const html = render({ value: '3', occupiedSlots: [4] });
  assert.match(inputs(html)[3], /checked=""/);
  assert.equal(inputs(html).filter(input => input.includes('checked=""')).length, 1);
  assert.equal((html.match(/finger-hand-digit is-selected/g) || []).length, 1);
  assert.match(html, /role="status" aria-live="polite"[^>]*>[\s\S]*?<span>Índice izquierdo<\/span>/);
  assert.match(html, /translate\(210 0\) scale\(-1 1\)/);
  assert.match(html, /<legend>Dedo<\/legend>/);
});

test('completed capture keeps the selected finger checked but locks it as registered', () => {
  const html = render({ value: '5', occupiedSlots: [5] });
  assert.match(inputs(html)[5], /checked=""/);
  assert.match(inputs(html)[5], /disabled=""/);
  assert.match(html, /Pulgar derecho · Registrado/);
  assert.doesNotMatch(html, /finger-hand-digit is-selected/);
});

test('selector can be disabled before inspection and during capture without a default finger', () => {
  const html = render({ disabled: true });
  assert.match(html, /^<fieldset class="finger-picker" disabled="">/);
  assert.match(html, /Sin seleccionar/);
  assert.equal(inputs(html).filter(input => input.includes('checked=""')).length, 0);
});

test('separate selectors use independent native radio groups', () => {
  const html = renderToStaticMarkup(React.createElement('div', null,
    React.createElement(FingerSelector, { value: '', onChange() {} }),
    React.createElement(FingerSelector, { value: '', onChange() {} })));
  assert.equal(new Set(inputs(html).map(input => input.match(/name="([^"]+)"/)[1])).size, 2);
});

test('enrollment integration clears confirmation on finger changes and keeps numeric API indices', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/FingerprintEnrollment.jsx'), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement' && node.openingElement.name.name === 'FingerSelector') nodes.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  assert.equal(nodes.length, 1);
  const handler = nodes[0].openingElement.attributes.find(attribute => attribute.name?.name === 'onChange').value.expression;
  assert.deepEqual(handler.body.body.map(statement => statement.expression.callee.name), ['setFinger', 'setConfirmed', 'setJob']);
  assert.equal(handler.body.body[1].expression.arguments[0].value, false);
  assert.match(source, /fingerIndex: Number\(finger\)/);
  assert.match(source, /disabled=\{!validEmployee\}/);
  assert.doesNotMatch(source, /<select id="enrollment-finger"/);
});
