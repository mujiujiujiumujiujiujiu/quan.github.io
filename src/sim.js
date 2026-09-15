const WORLD = { width: 1600, height: 820, minX: 42, maxX: 1558, minY: 42, maxY: 778 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const normalize = (x, y) => {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
};
const angleDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function freshStatus() {
  return {
    stun: 0,
    slow: 0,
    fear: 0,
    guard: 0,
    taunt: 0,
    tauntTarget: null,
    marked: 0,
    delayed: 0,
    delayedDamage: 0,
    delayedBy: null,
    damageReduction: 0,
  };
}

function copyData(data, overrides = {}) {
  return { ...data, ...overrides, skills: data.skills?.map((skill) => ({ ...skill })) ?? [] };
}

export class BattleSimulation {
  constructor(unitsById, level, deployments, onEvent = () => {}) {
    this.unitsById = unitsById;
    this.level = level;
    this.onEvent = onEvent;
    this.units = [];
    this.projectiles = [];
    this.effects = [];
    this.floatingTexts = [];
    this.logs = [];
    this.phase = 'battle';
    this.time = 0;
    this.goldBonus = 0;
    this.niuGold = 0;
    this.nextId = 1;
    this.rngState = (level.id * 0x9e3779b9) >>> 0;
    this.lastCombatLogAt = -99;
    this.wavePlans = this.buildWavePlans(level);
    this.waveIndex = 0;
    this.totalWaves = this.wavePlans.length;
    this.buildPlayerUnits(deployments);
    this.spawnWave(this.wavePlans[0]);
  }

  get aliveUnits() {
    return this.units.filter((unit) => unit.alive);
  }

  get alivePlayers() {
    return this.units.filter((unit) => unit.alive && unit.side === 'player');
  }

  get aliveEnemies() {
    return this.units.filter((unit) => unit.alive && unit.side === 'enemy');
  }

  get playerCount() {
    return this.alivePlayers.length;
  }

  get enemyCount() {
    return this.aliveEnemies.length;
  }

  start() {
    this.emit(`第 ${this.level.id} 关 · ${this.level.name} 开战，部署锁定。`, 'result');
    this.emit(`第 ${this.waveIndex + 1}/${this.totalWaves} 波敌人入场，战斗会自动进行。`, 'info');
    this.emit('清空当前波次后，下一波会立即入场，部署不会中途改变。', 'info');
  }

  update(deltaSeconds) {
    if (this.phase !== 'battle') return;
    const dt = clamp(deltaSeconds, 0, 0.05);
    this.time += dt;
    this.updateWorldTimers(dt);

    const alive = this.aliveUnits;
    for (const unit of alive) this.updateUnit(unit, alive, dt);
    this.resolveCollisions(this.aliveUnits);
    this.updateProjectiles(dt);
    this.updateVisualEffects(dt);

    if (this.playerCount === 0) {
      this.finish('lose');
    } else if (this.enemyCount === 0) {
      if (!this.advanceWave()) this.finish('win');
    } else if (this.time > 90) {
      const playerScore = this.alivePlayers.reduce((sum, unit) => sum + unit.hp, 0);
      const enemyScore = this.aliveEnemies.reduce((sum, unit) => sum + unit.hp, 0);
      this.finish(playerScore >= enemyScore ? 'win' : 'lose', true);
    }
  }

  finish(outcome, overtime = false) {
    if (this.phase !== 'battle') return;
    this.phase = 'result';
    this.outcome = outcome;
    const survivorCount = this.playerCount;
    if (overtime) this.emit('战斗拖太久，裁判按全场剩余生命值判定。', 'danger');
    this.emit(outcome === 'win' ? `胜利！${survivorCount} 名己方单位还站着。` : '失败。下次把预算花在更合适的克制上。', outcome === 'win' ? 'reward' : 'danger');
  }

  buildWavePlans(level) {
    const plans = Array.isArray(level.waves) && level.waves.length > 0 ? level.waves : [level.enemies];
    return plans
      .map((wave) => Array.isArray(wave) ? wave : wave.entries)
      .filter((wave) => Array.isArray(wave) && wave.length > 0);
  }

  spawnWave(entries) {
    this.buildEnemyUnits(entries);
  }

  advanceWave() {
    if (this.waveIndex >= this.totalWaves - 1) return false;
    this.waveIndex += 1;
    this.spawnWave(this.wavePlans[this.waveIndex]);
    this.emit(`第 ${this.waveIndex + 1}/${this.totalWaves} 波开始，敌人数量：${this.wavePlans[this.waveIndex].reduce((sum, entry) => sum + entry.count, 0)}。`, 'result');
    return true;
  }

  buildPlayerUnits(deployments) {
    for (const deployment of deployments) {
      const data = copyData(deployment.data ?? this.unitsById[deployment.unitId]);
      if (!data) continue;
      this.units.push(this.createUnit(data, 'player', deployment.x, deployment.y));
    }
  }

  buildEnemyUnits(entries) {
    let order = 0;
    for (const entry of entries) {
      for (let index = 0; index < entry.count; index += 1) {
        const data = copyData(this.unitsById[entry.unitId], entry.overrides ?? {});
        const column = order % 3;
        const row = Math.floor(order / 3);
        const x = 1120 + column * 122 + (row % 2) * 36;
        const y = 190 + row * 150 + (column % 2) * 28;
        this.units.push(this.createUnit(data, 'enemy', x, y));
        order += 1;
      }
    }
  }

  createUnit(data, side, x, y, extra = {}) {
    const unit = {
      id: `${side}-${data.id}-${this.nextId++}`,
      side,
      data,
      x,
      y,
      vx: 0,
      vy: 0,
      facing: side === 'player' ? 0 : Math.PI,
      hp: data.hp,
      maxHp: data.hp,
      alive: true,
      deadFor: 0,
      attackCd: 0.15 + this.random() * 0.65,
      skillCds: Object.fromEntries((data.skills ?? []).map((skill) => [skill.name, 2.5 + this.random() * 4])),
      attackCount: 0,
      kills: 0,
      pulse: 0,
      hitFlash: 0,
      status: freshStatus(),
      intent: 'advance',
      isSummon: false,
      ttl: null,
      ...extra,
    };
    return unit;
  }

  updateWorldTimers(dt) {
    for (const unit of this.units) {
      unit.pulse = Math.max(0, unit.pulse - dt);
      unit.hitFlash = Math.max(0, unit.hitFlash - dt);
      if (!unit.alive) {
        unit.deadFor += dt;
        continue;
      }

      const status = unit.status;
      for (const key of ['stun', 'slow', 'fear', 'guard', 'taunt', 'marked', 'delayed', 'damageReduction']) {
        status[key] = Math.max(0, status[key] - dt);
      }
      if (status.taunt <= 0) status.tauntTarget = null;
      if (unit.ttl !== null) {
        unit.ttl -= dt;
        if (unit.ttl <= 0) this.killUnit(unit, null, 'summon_expired');
      }
      for (const skill of unit.data.skills ?? []) {
        unit.skillCds[skill.name] = Math.max(0, (unit.skillCds[skill.name] ?? 0) - dt);
      }
      if (status.delayed <= 0 && status.delayedDamage > 0) {
        const markerSource = this.findUnit(status.delayedBy);
        if (markerSource?.alive) this.applyDamage(markerSource, unit, status.delayedDamage, 'mark', 65);
        status.delayedDamage = 0;
        status.delayedBy = null;
      }
    }
  }

  updateUnit(unit, alive, dt) {
    if (!unit.alive) return;
    if (unit.data.role === 'deployable') {
      unit.vx = 0;
      unit.vy = 0;
      unit.intent = 'hold';
      return;
    }

    const target = this.findTarget(unit, alive);
    this.trySkill(unit, target);
    if (!unit.alive || unit.status.stun > 0 || unit.status.fear > 0) {
      unit.intent = 'hold';
      this.brakeUnit(unit, dt);
      return;
    }

    unit.attackCd -= dt;
    if (!target) {
      if (this.shouldKeepDistance(unit)) {
        unit.intent = 'hold';
        this.brakeUnit(unit, dt);
      } else {
        unit.intent = 'advance';
        this.moveUnit(unit, unit.side === 'player' ? 1 : -1, 0.15, dt);
      }
      return;
    }

    const dx = target.x - unit.x;
    const dy = target.y - unit.y;
    const distanceToTarget = Math.hypot(dx, dy);
    const attackRange = unit.data.range + unit.data.radius * 0.35 + target.data.radius * 0.35;
    const direction = normalize(dx, dy);
    unit.facing = Math.atan2(dy, dx);
    const keepDistance = this.shouldKeepDistance(unit);
    const preferredDistance = this.getPreferredDistance(unit, attackRange);
    const retreatThreshold = Math.max(unit.data.radius + target.data.radius + 12, preferredDistance - 16);

    if (keepDistance && distanceToTarget < retreatThreshold) {
      unit.intent = 'retreat';
      const speedMultiplier = (unit.status.slow > 0 ? 1 - this.getSlowAmount(unit) : 1) * 1.12;
      if (distanceToTarget <= attackRange && unit.attackCd <= 0 && unit.data.atk > 0 && unit.data.range > 100) {
        this.attack(unit, target, direction);
      }
      this.moveUnit(unit, -direction.x, -direction.y, dt, speedMultiplier);
      return;
    }

    if (distanceToTarget <= attackRange) {
      unit.intent = keepDistance ? 'hold' : 'engage';
      this.brakeUnit(unit, dt);
      if (unit.attackCd <= 0 && unit.data.atk > 0) this.attack(unit, target, direction);
    } else if (keepDistance && unit.data.range <= 100) {
      unit.intent = 'hold';
      this.brakeUnit(unit, dt);
    } else {
      unit.intent = 'advance';
      const speedMultiplier = unit.status.slow > 0 ? 1 - this.getSlowAmount(unit) : 1;
      this.moveUnit(unit, direction.x, direction.y, dt, speedMultiplier);
    }
  }

  shouldKeepDistance(unit) {
    const style = unit.data.combatStyle ?? unit.data.role;
    return Boolean(unit.isSummon || style === 'ranged' || style === 'support' || unit.data.role === 'healer' || unit.data.range > 100);
  }

  getPreferredDistance(unit, attackRange) {
    const configured = Number(unit.data.preferredDistance);
    if (Number.isFinite(configured) && configured > 0) return configured;
    if (unit.data.range > 100) return Math.max(180, attackRange - 70);
    if (unit.isSummon) return Math.max(110, attackRange - 18);
    return Math.max(140, unit.data.range + 90);
  }

  brakeUnit(unit, dt) {
    unit.vx *= Math.max(0, 1 - dt * 10);
    unit.vy *= Math.max(0, 1 - dt * 10);
    unit.x += unit.vx * dt;
    unit.y += unit.vy * dt;
    this.keepInside(unit);
  }

  moveUnit(unit, directionX, directionY, dt, speedMultiplier = 1) {
    const speed = unit.data.spd * speedMultiplier * (unit.data.id === 'dayun' && unit.hp / unit.maxHp < 0.4 ? 1.22 : 1);
    const acceleration = 7.5;
    unit.vx += directionX * acceleration * speed * dt;
    unit.vy += directionY * acceleration * speed * dt;
    const maxSpeed = speed * 1.15;
    const velocity = Math.hypot(unit.vx, unit.vy);
    if (velocity > maxSpeed) {
      unit.vx = (unit.vx / velocity) * maxSpeed;
      unit.vy = (unit.vy / velocity) * maxSpeed;
    }
    const damping = Math.max(0, 1 - dt * 2.6);
    unit.vx *= damping;
    unit.vy *= damping;
    unit.x += unit.vx * dt;
    unit.y += unit.vy * dt;
    unit.facing = Math.atan2(directionY, directionX);
    this.keepInside(unit);
  }

  findTarget(unit, alive) {
    if (unit.status.tauntTarget) {
      const forced = this.findUnit(unit.status.tauntTarget);
      if (forced?.alive && forced.side !== unit.side) return forced;
    }
    let candidates = alive.filter((candidate) => candidate.side !== unit.side && candidate.id !== unit.id);
    if (unit.data.targetPriority === 'enemy_ranged') {
      const backline = candidates.filter((candidate) => ['ranged', 'healer', 'support'].includes(candidate.data.role));
      if (backline.length > 0) candidates = backline;
    }
    candidates.sort((first, second) => distance(unit, first) - distance(unit, second));
    return candidates[0] ?? null;
  }

  trySkill(unit, target) {
    const skills = unit.data.skills ?? [];
    for (let index = 0; index < skills.length; index += 1) {
      const skill = skills[index];
      if ((unit.skillCds[skill.name] ?? 0) > 0) continue;
      const used = this.useSkill(unit, target, skill, index);
      if (used) return;
    }
  }

  useSkill(unit, target, skill, index) {
    const enemies = this.aliveUnits.filter((candidate) => candidate.side !== unit.side);
    const allies = this.aliveUnits.filter((candidate) => candidate.side === unit.side && candidate.id !== unit.id);
    const nearbyEnemies = (center, radius) => enemies.filter((candidate) => distance(center, candidate) <= radius + candidate.data.radius * 0.25);
    const setCooldown = () => { unit.skillCds[skill.name] = skill.cd; };
    const displaySkill = () => {
      this.addEffect('skill', unit.x, unit.y, unit.data.accent, skill.radius ?? 75, 0.48);
      this.emit(`${unit.data.name}：${skill.name}`, 'skill');
    };

    if (skill.type === 'dash' && target && distance(unit, target) < 420) {
      const direction = normalize(target.x - unit.x, target.y - unit.y);
      unit.x = clamp(target.x - direction.x * (target.data.radius + unit.data.radius + 10), WORLD.minX, WORLD.maxX);
      unit.y = clamp(target.y - direction.y * (target.data.radius + unit.data.radius + 10), WORLD.minY, WORLD.maxY);
      this.applyDamage(unit, target, skill.damage, 'skill', skill.knockback);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'execute' && target && target.hp / target.maxHp <= skill.threshold) {
      this.applyDamage(unit, target, unit.data.atk * (1 + skill.bonus), 'execute', 100);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'cone' && target && distance(unit, target) < skill.radius) {
      for (const candidate of nearbyEnemies(unit, skill.radius)) {
        this.applyDamage(unit, candidate, skill.damage, 'skill', 70);
        candidate.status.stun = Math.max(candidate.status.stun, skill.stun ?? 0);
      }
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'pulse' && target && distance(unit, target) < unit.data.range + 30) {
      for (const candidate of nearbyEnemies(target, skill.radius)) {
        this.applyDamage(unit, candidate, skill.damage, 'aoe', 75);
        candidate.status.slow = Math.max(candidate.status.slow, 3.2);
      }
      unit.status.damageReduction = Math.max(unit.status.damageReduction, 2.2);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'charge' && target && distance(unit, target) > 120) {
      const direction = normalize(target.x - unit.x, target.y - unit.y);
      unit.x = clamp(unit.x + direction.x * 230, WORLD.minX, WORLD.maxX);
      unit.y = clamp(unit.y + direction.y * 230, WORLD.minY, WORLD.maxY);
      for (const candidate of nearbyEnemies(unit, 105)) {
        this.applyDamage(unit, candidate, skill.damage, 'charge', skill.knockback);
        candidate.status.stun = Math.max(candidate.status.stun, skill.stun ?? 0.8);
      }
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'slowPulse' && target) {
      for (const candidate of nearbyEnemies(target, skill.radius)) candidate.status.slow = Math.max(candidate.status.slow, 4.5);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'guard') {
      unit.status.guard = skill.duration;
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'taunt') {
      const taunted = nearbyEnemies(unit, skill.radius);
      if (taunted.length === 0) return false;
      for (const enemy of taunted) {
        enemy.status.taunt = Math.max(enemy.status.taunt, skill.duration);
        enemy.status.tauntTarget = unit.id;
      }
      unit.status.damageReduction = Math.max(unit.status.damageReduction, 2.5);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'fear') {
      const targets = nearbyEnemies(unit, skill.radius);
      if (targets.length === 0) return false;
      for (const enemy of targets) {
        this.applyDamage(unit, enemy, skill.damage, 'skill', 55);
        enemy.status.fear = Math.max(enemy.status.fear, skill.stun);
      }
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'aoe' && target && distance(unit, target) < unit.data.range + 70) {
      for (const candidate of nearbyEnemies(target, skill.radius)) this.applyDamage(unit, candidate, skill.damage, 'aoe', 45);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'summon' && target) {
      const summonData = copyData(this.unitsById.couqie, { name: '小橘猫', hp: 100, atk: 14, as: 2, spd: 105, range: 150, radius: 16, color: unit.data.accent, accent: unit.data.color, role: 'swarm', combatStyle: 'ranged', preferredDistance: 130, spriteIndex: 6 });
      for (let count = 0; count < skill.count; count += 1) {
        const angle = count === 0 ? -0.8 : 0.8;
        const summon = this.createUnit(summonData, unit.side, unit.x + Math.cos(angle) * 48, unit.y + Math.sin(angle) * 48, { isSummon: true, ttl: skill.duration });
        this.units.push(summon);
      }
      setCooldown();
      displaySkill();
      this.emit('临时召唤物加入混战，场面更挤了。', 'info');
      return true;
    }

    if (skill.type === 'aoeSlow' && target && distance(unit, target) < 260) {
      for (const candidate of nearbyEnemies(unit, skill.radius)) candidate.status.slow = Math.max(candidate.status.slow, 4);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'aoeDebuff' && target && distance(unit, target) < skill.radius + 80) {
      for (const candidate of nearbyEnemies(target, skill.radius)) candidate.status.slow = Math.max(candidate.status.slow, 3.5);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'heal') {
      const injured = allies.filter((ally) => ally.hp < ally.maxHp * 0.92).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      if (!injured) return false;
      const amount = Math.min(skill.amount, injured.maxHp - injured.hp);
      injured.hp += amount;
      injured.pulse = 0.55;
      this.floatingTexts.push({ x: injured.x, y: injured.y - 38, text: `+${Math.round(amount)}`, color: '#9cf6a6', life: 0.9, maxLife: 0.9 });
      this.addEffect('heal', injured.x, injured.y, '#9cf6a6', 68, 0.55);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'delayed' && target && target.status.delayed <= 0) {
      target.status.delayed = skill.delay;
      target.status.delayedDamage = skill.damage;
      target.status.delayedBy = unit.id;
      this.addEffect('mark', target.x, target.y, '#ffe066', 44, skill.delay);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'aura') {
      const targets = nearbyEnemies(unit, skill.radius);
      if (targets.length === 0) return false;
      for (const enemy of targets) enemy.status.slow = Math.max(enemy.status.slow, 2.5);
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'blink' && target && distance(unit, target) < 600) {
      const side = target.side === 'enemy' ? 1 : -1;
      unit.x = clamp(target.x + side * (target.data.radius + unit.data.radius + 8), WORLD.minX, WORLD.maxX);
      unit.y = clamp(target.y + (this.random() - 0.5) * 70, WORLD.minY, WORLD.maxY);
      unit.status.damageReduction = Math.max(unit.status.damageReduction, 0.55);
      unit.pulse = 0.8;
      setCooldown();
      displaySkill();
      return true;
    }

    if (skill.type === 'mark' && target) {
      target.status.marked = 5;
      target.status.slow = Math.max(target.status.slow, 5);
      setCooldown();
      displaySkill();
      return true;
    }

    return false;
  }

  attack(attacker, target, direction) {
    attacker.attackCount += 1;
    const damage = this.getAttackDamage(attacker);
    if (attacker.data.range > 100) {
      this.projectiles.push({
        x: attacker.x,
        y: attacker.y,
        targetId: target.id,
        side: attacker.side,
        speed: 560,
        damage,
        color: attacker.data.accent,
        life: 2.2,
      });
      attacker.attackCd = 1 / Math.max(0.2, attacker.data.as);
    } else {
      this.applyDamage(attacker, target, damage, 'hit', 26 + attacker.data.atk * 0.65);
      attacker.attackCd = 1 / Math.max(0.2, attacker.data.as);
    }
    attacker.facing = Math.atan2(direction.y, direction.x);

    if (attacker.data.id === 'caixukun' && attacker.attackCount % 4 === 0) {
      for (const candidate of this.aliveUnits.filter((unit) => unit.side !== attacker.side && distance(attacker, unit) < 105)) {
        this.applyDamage(attacker, candidate, 25, 'combo', 30);
        candidate.status.slow = Math.max(candidate.status.slow, 2);
      }
      this.addEffect('skill', attacker.x, attacker.y, '#c7b8ff', 105, 0.45);
      this.emit('蔡徐坤打出第四拍，附近单位一起吃到节奏。', 'skill');
    }
    if (this.time - this.lastCombatLogAt > 0.7 && this.random() > 0.35) {
      this.lastCombatLogAt = this.time;
      this.emit(`${attacker.data.name} 命中 ${target.data.name} -${Math.round(damage)}`, 'combat');
    }
  }

  getAttackDamage(attacker) {
    let amount = attacker.data.atk;
    if (attacker.data.id === 'dayun' && attacker.hp / attacker.maxHp < 0.4) amount *= 1.2;
    if (attacker.data.id === 'huaqiang' && this.random() < 0.15) amount *= 2;
    if (attacker.data.id === 'miaocuijiao' && attacker.pulse > 0) amount *= 2;
    if (attacker.data.id === 'couqie' || attacker.data.id === 'gugugaga') {
      const sameSide = this.aliveUnits.filter((unit) => unit.side === attacker.side && (unit.data.id === 'couqie' || unit.data.id === 'gugugaga')).length;
      amount *= 1 + Math.min(5, sameSide - 1) * 0.03;
    }
    return amount;
  }

  applyDamage(source, target, rawDamage, kind = 'hit', knockback = 0) {
    if (!target?.alive) return;
    let damage = rawDamage;
    if (target.data.id === 'gazi') {
      const incoming = Math.atan2((source?.y ?? target.y) - target.y, (source?.x ?? target.x) - target.x);
      const isFront = Math.abs(angleDifference(incoming, target.facing)) < Math.PI / 2;
      if (isFront) damage *= 0.5;
    }
    if (target.status.guard > 0) damage *= 0.3;
    if (target.status.damageReduction > 0) damage *= 0.7;
    if (target.data.id === 'dayun' && target.hp / target.maxHp < 0.4) damage *= 1.15;
    damage = Math.max(1, damage);
    target.hp = Math.max(0, target.hp - damage);
    target.hitFlash = 0.16;
    target.pulse = Math.max(target.pulse, 0.22);
    this.floatingTexts.push({ x: target.x, y: target.y - target.data.radius - 8, text: `-${Math.round(damage)}`, color: kind === 'skill' || kind === 'aoe' ? '#ffd166' : '#fff1e6', life: 0.82, maxLife: 0.82 });
    if (knockback > 0 && source) {
      const direction = normalize(target.x - source.x, target.y - source.y);
      target.vx += direction.x * knockback;
      target.vy += direction.y * knockback;
    }
    if (target.hp <= 0) this.killUnit(target, source, kind);
  }

  killUnit(target, source, reason = 'damage') {
    if (!target.alive) return;
    target.alive = false;
    target.deadFor = 0;
    target.vx = 0;
    target.vy = 0;
    if (source?.alive) {
      source.kills += 1;
      this.goldBonus += 1;
      if (source.data.id === 'niulai' && this.niuGold < 20) {
        this.niuGold += 1;
        this.goldBonus += 1;
      }
    }
    this.addEffect('death', target.x, target.y, target.data.color, target.data.radius * 2.2, 0.62);
    this.emit(`${target.data.name} 出局${reason === 'summon_expired' ? '（召唤时间到）' : ''}。`, 'danger');
  }

  updateProjectiles(dt) {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.life -= dt;
      const target = this.findUnit(projectile.targetId);
      if (!target?.alive || projectile.life <= 0) {
        this.projectiles.splice(index, 1);
        continue;
      }
      const direction = normalize(target.x - projectile.x, target.y - projectile.y);
      const step = projectile.speed * dt;
      projectile.x += direction.x * step;
      projectile.y += direction.y * step;
      if (distance(projectile, target) < target.data.radius + 10) {
        const fakeSource = this.findUnitBySideNear(projectile.side, projectile.x, projectile.y);
        this.applyDamage(fakeSource, target, projectile.damage, 'projectile', 32);
        this.addEffect('hit', projectile.x, projectile.y, projectile.color, 34, 0.24);
        this.projectiles.splice(index, 1);
      }
    }
  }

  resolveCollisions(alive) {
    for (let firstIndex = 0; firstIndex < alive.length; firstIndex += 1) {
      const first = alive[firstIndex];
      for (let secondIndex = firstIndex + 1; secondIndex < alive.length; secondIndex += 1) {
        const second = alive[secondIndex];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const length = Math.hypot(dx, dy) || 0.01;
        const minimum = (first.data.radius + second.data.radius) * 0.68;
        if (length >= minimum) continue;
        const direction = { x: dx / length, y: dy / length };
        const correction = (minimum - length) * 0.5;
        first.x -= direction.x * correction;
        first.y -= direction.y * correction;
        second.x += direction.x * correction;
        second.y += direction.y * correction;
        first.vx -= direction.x * 4;
        first.vy -= direction.y * 4;
        second.vx += direction.x * 4;
        second.vy += direction.y * 4;
      }
    }
    for (const unit of alive) this.keepInside(unit);
  }

  keepInside(unit) {
    const padding = unit.data.radius * 0.6;
    if (unit.x < WORLD.minX + padding) { unit.x = WORLD.minX + padding; unit.vx = Math.abs(unit.vx) * 0.45; }
    if (unit.x > WORLD.maxX - padding) { unit.x = WORLD.maxX - padding; unit.vx = -Math.abs(unit.vx) * 0.45; }
    if (unit.y < WORLD.minY + padding) { unit.y = WORLD.minY + padding; unit.vy = Math.abs(unit.vy) * 0.45; }
    if (unit.y > WORLD.maxY - padding) { unit.y = WORLD.maxY - padding; unit.vy = -Math.abs(unit.vy) * 0.45; }
  }

  getSlowAmount(unit) {
    if (unit.data.id === 'gugugaga') return 0.5;
    return 0.35;
  }

  updateVisualEffects(dt) {
    for (const effect of this.effects) effect.life -= dt;
    this.effects = this.effects.filter((effect) => effect.life > 0);
    for (const text of this.floatingTexts) {
      text.life -= dt;
      text.y -= dt * 28;
    }
    this.floatingTexts = this.floatingTexts.filter((text) => text.life > 0);
  }

  addEffect(type, x, y, color, radius, duration) {
    this.effects.push({ type, x, y, color, radius, duration, life: duration });
  }

  findUnit(id) {
    return this.units.find((unit) => unit.id === id) ?? null;
  }

  findUnitBySideNear(side, x, y) {
    return this.aliveUnits
      .filter((unit) => unit.side === side)
      .sort((first, second) => Math.hypot(first.x - x, first.y - y) - Math.hypot(second.x - x, second.y - y))[0] ?? null;
  }

  emit(text, tone = 'info') {
    const event = { text, tone, id: `${this.time}-${this.logs.length}` };
    this.logs.push(event);
    if (this.logs.length > 12) this.logs.shift();
    this.onEvent(event);
  }

  random() {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 0x100000000;
  }
}

export { WORLD };
