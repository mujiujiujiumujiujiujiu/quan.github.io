import { readFile } from 'node:fs/promises';

const units = JSON.parse(await readFile(new URL('../data/units.json', import.meta.url), 'utf8'));
const levels = JSON.parse(await readFile(new URL('../data/levels.json', import.meta.url), 'utf8'));

if (!Array.isArray(units.units) || units.units.length < 10) throw new Error('units.json: units 太少');
if (!Array.isArray(levels.levels) || levels.levels.length !== 6) throw new Error('levels.json: 必须有 6 关');

const ids = new Set(units.units.map((unit) => unit.id));
for (const unit of units.units) {
  for (const key of ['id', 'name', 'role', 'color', 'accent']) {
    if (!unit[key]) throw new Error(`units.json: ${unit.id ?? 'unknown'} 缺少 ${key}`);
  }
  if (!Number.isFinite(unit.hp) || !Number.isFinite(unit.price) || !Number.isFinite(unit.radius)) {
    throw new Error(`units.json: ${unit.id} 数值不完整`);
  }
}
for (const level of levels.levels) {
  if (!Number.isFinite(level.budget) || !Array.isArray(level.enemies) || level.enemies.length === 0 || !Array.isArray(level.waves) || level.waves.length < 2) {
    throw new Error(`levels.json: ${level.id} 结构不完整`);
  }
  for (const entry of level.enemies) if (!ids.has(entry.unitId)) throw new Error(`levels.json: 未知单位 ${entry.unitId}`);
  for (const wave of level.waves) {
    if (!Array.isArray(wave) || wave.length === 0) throw new Error(`levels.json: ${level.id} 波次为空`);
    for (const entry of wave) {
      if (!ids.has(entry.unitId) || !Number.isFinite(entry.count) || entry.count < 1) {
        throw new Error(`levels.json: ${level.id} 波次单位不完整`);
      }
    }
  }
}

const playable = units.units.filter((unit) => !unit.enemyOnly);
const prices = playable.map((unit) => unit.price);
if (Math.max(...prices) !== 500 || Math.min(...prices) !== 90) throw new Error('units.json: 价格范围不符合设计');
console.log(`data ok: ${playable.length} playable units, ${levels.levels.length} levels`);
