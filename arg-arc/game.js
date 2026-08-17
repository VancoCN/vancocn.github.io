/*
 * ARC ARG - Global Game Logic v2.0
 * 
 * HIDDEN CLUE: The save system itself is a clue.
 * Check what gets saved and when.
 * 
 * ARC_GAME is exposed globally. Type ARC_GAME.help() in console.
 *
 * ===== FRAGMENT SYSTEM =====
 * There are 3 hex fragments that unlock the true ending:
 *   Fragment 1: 7f3a  (hidden in <meta name="arc-fragment-1"> on index.html)
 *   Fragment 2: 9c21  (revealed when DevTools is opened, and in console logs)
 *   Fragment 3: e84d  (hidden in the timeline source comment on index.html)
 *
 * Collect all 3, then visit: hidden/archive.html?key=7f3a9c21e84d
 * Or type ARC_GAME.forceEnding('perfect') to skip ahead.
 */

(function() {
  'use strict';

  // ===== 游戏状态管理 =====
  const ARC_GAME = {
    version: '2.0.0',
    state: {
      cluesFound: 0,
      keysDiscovered: [],
      pagesVisited: [],
      choicesMade: [],
      awarenessLevel: 0,
      fragmentsCollected: 0,
      fragments: {
        '7f3a': false,
        '9c21': false,
        'e84d': false,
      },
      endingReached: null,
      startTime: Date.now(),
      sessionCount: 0,
      devToolsOpened: false,
      sourceViewed: false,
    },

    // 持久化存储键
    storageKey: 'arc_arg_save_v2',

    // 结局阈值
    thresholds: {
      bad: 0,        // 0-19% awareness → bad ending
      normal: 20,     // 20-59% awareness → normal ending
      good: 60,       // 60-99% awareness → good ending
      perfect: 100,   // 100% (all fragments + key) → perfect ending
    },

    // ===== 初始化 =====
    init: function() {
      this.loadState();
      this.state.sessionCount++;
      this.saveState();

      // 记录当前页面访问
      const page = this.getCurrentPage();
      if (!this.state.pagesVisited.includes(page)) {
        this.state.pagesVisited.push(page);
      }

      // 检查 URL 参数中的线索
      this.checkUrlClues();

      // 更新认知度
      this.updateAwareness();

      // 控制台欢迎
      this.consoleWelcome();
    },

    // ===== 获取当前页面标识 =====
    getCurrentPage: function() {
      const path = window.location.pathname;
      const file = path.split('/').pop() || 'index.html';
      return file;
    },

    // ===== 检查 URL 中的线索参数 =====
    checkUrlClues: function() {
      const params = new URLSearchParams(window.location.search);
      let foundNew = false;

      // 通用线索参数
      const clueParams = ['view', 'decrypt', 'key', 'auth', 'clues', 'cmd', 'auto', 'fragments', 'mode', 'from', 'bypass', 'subject', 'node'];
      clueParams.forEach(param => {
        if (params.has(param)) {
          const value = params.get(param);
          const clueId = `${param}=${value}`;
          if (!this.state.keysDiscovered.includes(clueId)) {
            this.state.keysDiscovered.push(clueId);
            foundNew = true;
          }
        }
      });

      // 特殊：直接通过 URL 提交密钥
      const keyParam = params.get('key');
      if (keyParam && keyParam.length === 12) {
        // 可能是合并的密钥 7f3a9c21e84d
        const f1 = keyParam.substring(0, 4);
        const f2 = keyParam.substring(4, 8);
        const f3 = keyParam.substring(8, 12);
        if (f1 === '7f3a' && f2 === '9c21' && f3 === 'e84d') {
          this.registerFragment('7f3a', true);
          this.registerFragment('9c21', true);
          this.registerFragment('e84d', true);
        }
      }

      // 特殊：单个碎片参数
      const fragParam = params.get('fragment');
      if (fragParam) {
        this.registerFragment(fragParam.toLowerCase(), true);
      }

      if (foundNew) {
        this.saveState();
      }
    },

    // ===== 添加线索 =====
    addClue: function(clueId, description) {
      if (!this.state.keysDiscovered.includes(clueId)) {
        this.state.keysDiscovered.push(clueId);
        this.state.cluesFound++;
        this.updateAwareness();
        this.saveState();

        console.log('%c[ARC GAME]', 'color: #00ff88;', `New clue found: ${description || clueId}`);
        console.log('%c[ARC GAME]', 'color: #00e5ff;', `Clues: ${this.state.cluesFound} | Fragments: ${this.state.fragmentsCollected}/3`);

        if (this.state.cluesFound >= 3 && !this.state.keysDiscovered.includes('milestone-3')) {
          this.state.keysDiscovered.push('milestone-3');
          console.log('%c[ARC GAME]', 'color: #ffaa00;', 'Milestone: You are no longer an ordinary visitor.');
        }
        if (this.state.cluesFound >= 5 && !this.state.keysDiscovered.includes('milestone-5')) {
          this.state.keysDiscovered.push('milestone-5');
          console.log('%c[ARC GAME]', 'color: #ffaa00;', 'Milestone: The bridge is responding to your presence.');
        }

        // 检查是否所有碎片都收集了
        if (this.state.fragmentsCollected >= 3) {
          console.log('%c[ARC GAME]', 'color: #00ff88; font-size: 14px; font-weight: bold;', '◈ ALL FRAGMENTS COLLECTED ◈');
          console.log('%c[ARC GAME]', 'color: #00ff88;', 'Go to: hidden/archive.html?key=7f3a9c21e84d');
          console.log('%c[ARC GAME]', 'color: #ffaa00;', 'Or type: ARC_GAME.openArchive()');
        }
      }
    },

    // ===== 注册密钥碎片（核心系统） =====
    registerFragment: function(fragment, silent) {
      fragment = fragment.toLowerCase().trim();

      // 验证是否为有效碎片
      if (!this.state.fragments.hasOwnProperty(fragment)) {
        if (!silent) {
          console.log('%c[ARC GAME]', 'color: #ff0040;', `Unknown fragment: ${fragment}`);
          console.log('%c[ARC GAME]', 'color: #ffaa00;', 'Valid fragments: 7f3a, 9c21, e84d');
        }
        return { success: false, message: `Unknown fragment: ${fragment}` };
      }

      if (this.state.fragments[fragment]) {
        if (!silent) {
          console.log('%c[ARC GAME]', 'color: #008899;', `Fragment ${fragment} already collected.`);
        }
        return { success: false, message: `Fragment ${fragment} already in your possession.` };
      }

      // 接受新碎片
      this.state.fragments[fragment] = true;
      this.state.fragmentsCollected = Object.values(this.state.fragments).filter(Boolean).length;
      this.state.cluesFound++;
      this.updateAwareness();
      this.saveState();

      const messages = {
        '7f3a': 'Fragment 1/3 [7f3a] accepted. "We did not build the bridge. We found it."',
        '9c21': 'Fragment 2/3 [9c21] accepted. "The observers are not gods. They are auditors."',
        'e84d': 'Fragment 3/3 [e84d] accepted. "When you have all three, go to the archive. The door is your awareness."',
      };

      const resultMsg = messages[fragment] || `Fragment [${fragment}] accepted.`;
      
      if (!silent) {
        console.log('%c[ARC GAME]', 'color: #00ff88; font-size: 13px; font-weight: bold;', resultMsg);
        console.log('%c[ARC GAME]', 'color: #00e5ff;', `Fragments: ${this.state.fragmentsCollected}/3`);
      }

      // 全部收集完成
      if (this.state.fragmentsCollected >= 3) {
        if (!silent) {
          console.log('%c[ARC GAME]', 'color: #00ff88; font-size: 14px; font-weight: bold;', '◈ ALL FRAGMENTS COLLECTED ◈');
          console.log('%c[ARC GAME]', 'color: #00ff88;', 'Opening archive...');
        }
        // 延迟跳转，让玩家看到提示
        setTimeout(() => {
          this.openArchive();
        }, 2000);
      }

      return { success: true, message: resultMsg };
    },

    // ===== 打开档案库（完美结局入口） =====
    openArchive: function() {
      if (this.state.fragmentsCollected >= 3) {
        window.location.href = 'hidden/archive.html?key=7f3a9c21e84d';
      } else {
        console.log('%c[ARC GAME]', 'color: #ff0040;', `Access denied. Fragments: ${this.state.fragmentsCollected}/3`);
        console.log('%c[ARC GAME]', 'color: #ffaa00;', 'You need all 3 fragments to enter the archive.');
        console.log('%c[ARC GAME]', 'color: #008899;', 'Fragment locations:');
        console.log('%c[ARC GAME]', 'color: #008899;', '  7f3a → <meta name="arc-fragment-1"> in page source');
        console.log('%c[ARC GAME]', 'color: #008899;', '  9c21 → Revealed when DevTools opens');
        console.log('%c[ARC GAME]', 'color: #008899;', '  e84d → Hidden comment in timeline section');
      }
    },

    // ===== 更新认知完整度 =====
    updateAwareness: function() {
      // 基础: 访问的页面数量 (最多 30%)
      const pageBonus = Math.min(this.state.pagesVisited.length * 5, 30);

      // 线索 bonus (最多 25%)
      const clueBonus = Math.min(this.state.cluesFound * 3, 25);

      // URL 参数 bonus (最多 10%)
      const keyBonus = Math.min(this.state.keysDiscovered.length * 2, 10);

      // 选择 bonus (最多 10%)
      const choiceBonus = Math.min(this.state.choicesMade.length * 3, 10);

      // 碎片 bonus (每个碎片 15%，全部收集额外 +10%，上限 100%)
      let fragmentBonus = this.state.fragmentsCollected * 15;
      if (this.state.fragmentsCollected >= 3) fragmentBonus += 10;

      let total = pageBonus + clueBonus + keyBonus + choiceBonus + fragmentBonus;
      total = Math.min(total, 100);

      this.state.awarenessLevel = total;
    },

    // ===== 保存状态 =====
    saveState: function() {
      const data = JSON.stringify(this.state);
      try {
        localStorage.setItem(this.storageKey, data);
      } catch(e) {
        try {
          sessionStorage.setItem(this.storageKey, data);
        } catch(e2) {
          // 完全不可用，存在内存中（已自动完成）
        }
      }
    },

    // ===== 加载状态 =====
    loadState: function() {
      try {
        const saved = localStorage.getItem(this.storageKey) || sessionStorage.getItem(this.storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          // 合并，保留默认值
          Object.assign(this.state, parsed);
          // 重新计算碎片数量（防止状态不一致）
          this.state.fragmentsCollected = Object.values(this.state.fragments || {}).filter(Boolean).length;
        }
      } catch(e) {
        // 损坏的存档，忽略
      }
    },

    // ===== 重置游戏 =====
    reset: function() {
      localStorage.removeItem(this.storageKey);
      sessionStorage.removeItem(this.storageKey);
      this.state = {
        cluesFound: 0,
        keysDiscovered: [],
        pagesVisited: [],
        choicesMade: [],
        awarenessLevel: 0,
        fragmentsCollected: 0,
        fragments: { '7f3a': false, '9c21': false, 'e84d': false },
        endingReached: null,
        startTime: Date.now(),
        sessionCount: 0,
        devToolsOpened: false,
        sourceViewed: false,
      };
      console.log('%c[ARC GAME]', 'color: #ff0040; font-size: 14px; font-weight: bold;', 'Game state reset. All progress erased.');
      console.log('%c[ARC GAME]', 'color: #ffaa00;', 'The bridge is open again. Start walking.');
      console.log('%c[ARC GAME]', 'color: #008899;', 'Type ARC_GAME.help() for commands.');
    },

    // ===== 记录选择 =====
    recordChoice: function(choice) {
      this.state.choicesMade.push({
        choice: choice,
        page: this.getCurrentPage(),
        time: Date.now()
      });
      this.updateAwareness();
      this.saveState();
    },

    // ===== 设置结局 =====
    setEnding: function(endingType) {
      this.state.endingReached = {
        type: endingType,
        time: Date.now(),
        awareness: this.state.awarenessLevel
      };
      this.saveState();

      const colors = {
        'bad': '#ff0040',
        'normal': '#ffaa00',
        'good': '#00e5ff',
        'perfect': '#00ff88',
      };
      const color = colors[endingType] || '#c0d0e0';

      console.log('%c[ARC GAME]', `color: ${color}; font-size: 16px; font-weight: bold;`, `ENDING REACHED: ${endingType.toUpperCase()}`);
      console.log('%c[ARC GAME]', 'color: #00e5ff;', `Awareness at ending: ${this.state.awarenessLevel}%`);
      console.log('%c[ARC GAME]', 'color: #ffaa00;', 'Type ARC_GAME.reset() to start over.');
    },

    // ===== 检查结局（在页面加载时调用） =====
    checkEnding: function() {
      const awareness = this.state.awarenessLevel;
      const page = this.getCurrentPage();
      const params = new URLSearchParams(window.location.search);

      // 完美结局：全部碎片 + 正确的 key 参数
      if (this.state.fragmentsCollected >= 3 && params.get('key') === '7f3a9c21e84d') {
        if (page === 'archive.html') {
          this.setEnding('perfect');
          return 'perfect';
        }
      }

      // 常规结局：awareness >= 60 但没集齐碎片
      if (awareness >= 60 && page === 'internal.html') {
        this.setEnding('good');
        return 'good';
      }

      // 坏结局：awareness < 20 且访问了特定页面
      if (awareness < 20 && page === 'index.html' && this.state.sessionCount > 3) {
        // 玩家多次访问但从未探索 → 被标记
        return 'bad-pending';
      }

      return null;
    },

    // ===== 触发坏结局 =====
    triggerBadEnding: function() {
      this.setEnding('bad');
      // 重定向到重置页面
      setTimeout(() => {
        window.location.href = 'reset.html';
      }, 1000);
    },

    // ===== 获取状态（供页面脚本调用） =====
    getState: function() {
      return {
        cluesFound: this.state.cluesFound,
        fragmentsCollected: this.state.fragmentsCollected,
        fragments: { ...this.state.fragments },
        awarenessLevel: this.state.awarenessLevel,
        pagesVisited: [...this.state.pagesVisited],
        endingReached: this.state.endingReached,
        sessionCount: this.state.sessionCount,
      };
    },

    // ===== 控制台欢迎 =====
    consoleWelcome: function() {
      if (this.state.sessionCount === 1) {
        console.log('%c[ARC GAME]', 'color: #00e5ff; font-size: 12px;', `v${this.version} initialized.`);
        console.log('%c[ARC GAME]', 'color: #008899;', 'Type ARC_GAME.help() for commands.');
      }
    },

    // ===== 帮助 =====
    help: function() {
      console.log('%c[ARC GAME HELP]', 'color: #00e5ff; font-size: 14px;', 'Available commands:');
      console.log('%c  ARC_GAME.help()', 'color: #00e5ff;', '— Show this help');
      console.log('%c  ARC_GAME.status()', 'color: #00e5ff;', '— Show current game status');
      console.log('%c  ARC_GAME.fragments()', 'color: #00e5ff;', '— Show fragment collection status');
      console.log('%c  ARC_GAME.registerFragment(hex)', 'color: #00e5ff;', '— Register a fragment (7f3a/9c21/e84d)');
      console.log('%c  ARC_GAME.openArchive()', 'color: #00ff88;', '— Open archive (requires all 3 fragments)');
      console.log('%c  ARC_GAME.addClue(id, desc)', 'color: #00e5ff;', '— Manually add a clue');
      console.log('%c  ARC_GAME.recordChoice(c)', 'color: #00e5ff;', '— Record a player choice');
      console.log('%c  ARC_GAME.forceEnding(type)', 'color: #ff0040;', '— Force an ending (bad/normal/good/perfect)');
      console.log('%c  ARC_GAME.reset()', 'color: #ff0040;', '— Reset all progress');
      console.log('%c  ARC_GAME.cheat(level)', 'color: #ffaa00;', '— Set awareness level (cheat)');
      console.log('');
      console.log('%c[FRAGMENT HINTS]', 'color: #ffaa00;', '3 fragments hidden in: meta tags, console output, source comments');
    },

    // ===== 状态 =====
    status: function() {
      const s = this.state;
      console.log('%c[ARC GAME STATUS]', 'color: #00e5ff;', '━━━━━━━━━━━━━━━━━━━━');
      console.log(`  Clues found:     ${s.cluesFound}`);
      console.log(`  Keys found:      ${s.keysDiscovered.length}`);
      console.log(`  Pages visited:   ${s.pagesVisited.length} (${s.pagesVisited.join(', ')})`);
      console.log(`  Choices made:    ${s.choicesMade.length}`);
      console.log(`  Fragments:       ${s.fragmentsCollected}/3`);
      console.log(`  Awareness:       ${s.awarenessLevel}%`);
      console.log(`  Ending:          ${s.endingReached ? s.endingReached.type : 'None yet'}`);
      console.log(`  Sessions:        ${s.sessionCount}`);
      console.log('%c[ARC GAME STATUS]', 'color: #00e5ff;', '━━━━━━━━━━━━━━━━━━━━');
    },

    // ===== 碎片状态 =====
    fragments: function() {
      const f = this.state.fragments;
      console.log('%c[FRAGMENTS]', 'color: #00e5ff;', '━━━━━━━━━━━━━━━━━━━━');
      console.log(`  7f3a: ${f['7f3a'] ? '✓ COLLECTED' : '✗ MISSING'} — hidden in <meta name="arc-fragment-1">`);
      console.log(`  9c21: ${f['9c21'] ? '✓ COLLECTED' : '✗ MISSING'} — revealed when DevTools opens`);
      console.log(`  e84d: ${f['e84d'] ? '✓ COLLECTED' : '✗ MISSING'} — hidden in timeline source comment`);
      console.log(`  Total: ${this.state.fragmentsCollected}/3`);
      if (this.state.fragmentsCollected >= 3) {
        console.log('%c  All fragments collected! Type ARC_GAME.openArchive()', 'color: #00ff88; font-weight: bold;');
      }
      console.log('%c[FRAGMENTS]', 'color: #00e5ff;', '━━━━━━━━━━━━━━━━━━━━');
    },

    // ===== 作弊 =====
    cheat: function(level) {
      if (typeof level !== 'number') level = 100;
      this.state.awarenessLevel = Math.min(Math.max(level, 0), 100);
      this.saveState();
      console.log('%c[ARC GAME]', 'color: #ffaa00;', `Awareness set to ${this.state.awarenessLevel}%`);
      console.log('%c[ARC GAME]', 'color: #ff0040;', 'Cheating is not the same as understanding.');
    },

    // ===== 强制结局（调试用） =====
    forceEnding: function(type) {
      const valid = ['bad', 'normal', 'good', 'perfect'];
      if (!valid.includes(type)) {
        console.log('%c[ARC GAME]', 'color: #ff0040;', `Invalid ending type: ${type}`);
        console.log('%c[ARC GAME]', 'color: #ffaa00;', `Valid types: ${valid.join(', ')}`);
        return;
      }

      // 设置对应的状态
      switch(type) {
        case 'perfect':
          this.state.fragments['7f3a'] = true;
          this.state.fragments['9c21'] = true;
          this.state.fragments['e84d'] = true;
          this.state.fragmentsCollected = 3;
          this.state.awarenessLevel = 100;
          this.openArchive();
          break;
        case 'good':
          this.state.awarenessLevel = 75;
          window.location.href = 'internal.html?access=shadow';
          break;
        case 'normal':
          this.state.awarenessLevel = 40;
          window.location.href = 'whisper.html';
          break;
        case 'bad':
          this.state.awarenessLevel = 5;
          this.triggerBadEnding();
          break;
      }
      this.saveState();
      this.setEnding(type);
    },

    // ===== 标记源码已查看 =====
    markSourceViewed: function() {
      this.state.sourceViewed = true;
      this.addClue('source-viewed', 'Viewed page source code');
      this.saveState();
    },

    // ===== 标记 DevTools 已打开 =====
    markDevToolsOpened: function() {
      if (!this.state.devToolsOpened) {
        this.state.devToolsOpened = true;
        this.addClue('devtools-opened', 'Opened developer tools');
        // 自动授予 9c21 碎片
        this.registerFragment('9c21', false);
        this.saveState();
      }
    },
  };

  // ===== 暴露全局接口 =====
  window.ARC_GAME = ARC_GAME;

  // ===== 自动初始化 =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ARC_GAME.init());
  } else {
    ARC_GAME.init();
  }

  // ===== 全局快捷键 =====
  // 在控制台输入 ARC_GAME 即可访问

  // ===== 检测可能的源码查看行为 =====
  // 当控制台打开时自动注册 9c21 碎片
  let devToolsDetected = false;
  setInterval(() => {
    const threshold = 160;
    const isOpen = (window.outerHeight - window.innerHeight > threshold) || 
                   (window.outerWidth - window.innerWidth > threshold);
    if (isOpen && !devToolsDetected) {
      devToolsDetected = true;
      ARC_GAME.markDevToolsOpened();
    } else if (!isOpen && devToolsDetected) {
      devToolsDetected = false;
    }
  }, 2000);

})();
