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
const file = path.join(root, 'src/components/IssueNameTick.jsx');
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = module.paths;
loaded._compile(buildSync({ entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' }).outputFiles[0].text, file);
const { default: IssueNameTick, getIssueNameMotion } = loaded.exports;
const render = props => renderToStaticMarkup(React.createElement('svg', null,
  React.createElement(IssueNameTick, { x: 112, y: 50, payload: { value: 'Colaborador de prueba' }, ...props })));

test('short names and not-yet-measurable labels remain still', () => {
  for (const [text, width] of [[60, 104], [104, 104], [104.5, 104], [0, 104], [150, 0], [NaN, 104], [150, Infinity]]) {
    assert.deepEqual(getIssueNameMotion(text, width), { overflow: false, distance: 0, duration: 0 });
  }
});

test('overflow travels exactly one full copy plus the gap at a readable speed', () => {
  const motion = getIssueNameMotion(250.25, 104);
  assert.equal(motion.overflow, true);
  assert.equal(motion.distance, 283);
  assert.equal(motion.duration, 283 / 24);
  assert.ok(getIssueNameMotion(500, 104).duration > motion.duration);
  assert.equal(getIssueNameMotion(106, 104).duration, 8);
});

test('axis labels reserve one fixed clipped row and retain the full accessible name', () => {
  const name = 'MARIA FERNANDA LOPEZ HERNANDEZ CON NOMBRE LARGO';
  const html = render({ payload: { value: name } });
  assert.match(html, /<foreignObject x="8" y="39" width="104" height="22" overflow="hidden">/);
  assert.ok(html.includes(`aria-label="${name}"`));
  assert.ok(html.includes(`title="${name}"`));
  assert.ok(html.includes(`<span class="issue-name-text">${name}</span>`));
  assert.doesNotMatch(html, /\.\.\.|…/);
});

test('name whitespace is normalized without changing characters or interpreting markup', () => {
  const html = render({ payload: { value: '  José\n  <Nombre>  ' } });
  assert.match(html, /aria-label="José &lt;Nombre&gt;"/);
  assert.doesNotMatch(html, /<Nombre>/);
  assert.equal(render({ payload: { value: '' } }), '<svg></svg>');
  assert.equal(render({ x: NaN }), '<svg></svg>');
});

test('only the incidents chart uses the moving label and still shows its original data and tooltip', () => {
  const source = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const charts = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement' && node.openingElement.name.name === 'BarChart') charts.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  }
  walk(ast);
  const chart = charts.find(node => node.openingElement.attributes.some(attribute => attribute.name?.name === 'data' && attribute.value.expression.name === 'topIssueEmployees'));
  assert.ok(chart);
  const children = chart.children.filter(node => node.type === 'JSXElement');
  const axis = children.find(node => node.openingElement.name.name === 'YAxis');
  assert.equal(axis.openingElement.attributes.find(attribute => attribute.name?.name === 'tick').value.expression.openingElement.name.name, 'IssueNameTick');
  assert.equal(axis.openingElement.attributes.find(attribute => attribute.name?.name === 'interval').value.expression.value, 0);
  assert.deepEqual(children.filter(node => node.openingElement.name.name === 'Bar')
    .map(node => node.openingElement.attributes.find(attribute => attribute.name?.name === 'dataKey').value.value), ['lateCount', 'earlyLeaveCount']);
  const tooltips = children.filter(node => node.openingElement.name.name === 'RechartsTooltip');
  assert.equal(tooltips.length, 1);
  const content = tooltips[0].openingElement.attributes.find(attribute => attribute.name?.name === 'contentStyle').value.expression;
  assert.equal(content.properties.find(property => property.key.name === 'maxWidth').value.value, 220);
  assert.equal(content.properties.find(property => property.key.name === 'whiteSpace').value.value, 'normal');
  const position = tooltips[0].openingElement.attributes.find(attribute => attribute.name?.name === 'position').value.expression;
  assert.equal(position.properties.find(property => property.key.name === 'x').value.value, 4);
});

test('animation stays scoped, pauses for inspection, and honors reduced-motion preferences', () => {
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  assert.match(css, /\.issue-name-window:hover \.issue-name-track[^}]*animation-play-state: paused/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.issue-name-track\.is-scrolling \{ animation: none/);
  assert.match(css, /\.issue-name-window\.is-overflowing \{ overflow-x: auto/);
  assert.match(css, /\.issue-name-copy \{ display: none/);
});
