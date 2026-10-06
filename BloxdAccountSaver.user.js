// ==UserScript==
// @name         Bloxd.io 账号保存助手
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  在Bloxd.io中快速保存和上传账号（本地txt文件，无需跳转外部网站）
// @author       Vanco
// @match        *://*.bloxd.io/*
// @noframes
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    // ============ 工具函数 ============

    // 读取 cookie（支持多个候选名，兼容 ___Secure-3PSIDMC / __Secure-3PSIDMC）
    function getCookie(name) {
        const parts = ('; ' + document.cookie).split('; ' + name + '=');
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function getFirstCookie(names) {
        for (const n of names) {
            const v = getCookie(n);
            if (v) return { name: n, value: v };
        }
        return { name: null, value: null };
    }

    // cookie 候选名：官方wiki写法是三个下划线，代码中常见两个，一并兼容
    const SID_CANDIDATES = [
        '___Secure-3PSIDMC',
        '__Secure-3PSIDMC',
        '__Secure-3PSID',
        '___Secure-3PSID'
    ];

    // 安全文件名
    function safeFileName(name) {
        return String(name || 'unknown').replace(/[\\/:*?"<>|\s]+/g, '_');
    }

    function timestamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    // 下载文本为本地 txt
    function blobDownload(filename, text) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    function downloadText(filename, text) {
        if (typeof GM_download === 'function') {
            try {
                GM_download({
                    url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text),
                    name: filename,
                    saveAs: true,
                    onerror: () => blobDownload(filename, text)
                });
                return;
            } catch (e) { /* 落到 blob 方案 */ }
        }
        blobDownload(filename, text);
    }

    // 读取 localStorage 中的用户名
    function getUserName() {
        const keys = ['bloxd-lastUsedName', 'bloxd-lastUsedNick', 'lastUsedName'];
        for (const k of keys) {
            let v = localStorage.getItem(k);
            if (v) {
                // 值可能是 "abc"（带引号的JSON字符串），也可能是裸字符串
                v = v.replace(/^"+|"+$/g, '');
                try { v = JSON.parse(v); } catch (e) { /* 保持原样 */ }
                if (v) return String(v);
            }
        }
        return '';
    }

    // ============ 界面 ============
    function buildUI() {
        const popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
            'width:320px;background:#1f1e33EE;border:3px solid #fff;border-radius:10px;' +
            'padding:20px;box-shadow:0 0 10px rgba(0,0,0,.5);z-index:99999;text-align:center;' +
            'font-family:sans-serif;';

        const title = document.createElement('h2');
        title.style.cssText = 'color:#fff;margin:0 0 10px 0;font-size:18px;';
        title.textContent = 'Bloxd.io 账号管理';
        popup.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.style.cssText = 'color:#ccc;margin:0;font-size:13px;';
        subtitle.textContent = '请选择操作';
        popup.appendChild(subtitle);

        const btnBox = document.createElement('div');
        btnBox.style.cssText = 'display:flex;justify-content:space-around;flex-wrap:wrap;gap:10px;margin-top:18px;';
        popup.appendChild(btnBox);

        function createButton(text, onClick) {
            const b = document.createElement('button');
            b.style.cssText = 'padding:10px 16px;background:#333;color:#fff;border:none;' +
                'border-radius:5px;cursor:pointer;transition:transform .3s ease;font-size:13px;';
            b.textContent = text;
            b.addEventListener('mouseover', () => { b.style.transform = 'scale(1.1)'; });
            b.addEventListener('mouseout', () => { b.style.transform = 'scale(1)'; });
            b.addEventListener('click', onClick);
            return b;
        }

        // ---- 保存当前账号 -> 下载 txt ----
        const saveBtn = createButton('保存当前的账号', () => {
            const sid = getFirstCookie(SID_CANDIDATES);
            const userName = getUserName();

            const lines = [
                '# Bloxd.io 账号备份',
                `保存时间: ${new Date().toLocaleString()}`,
                `Cookie名: ${sid.name || '(未找到)'}`,
                `Secure-3PSIDMC: ${sid.value || ''}`,
                `用户名: ${userName || '(未找到)'}`,
                '',
                '# 以下为完整 cookie 串，用于完整还原登录状态，如果你只是普通用户，无需在意下方内容',
                `全量Cookie: ${document.cookie}`,
                '',
                '# 以下为 localStorage 快照',
                `LocalStorage: ${JSON.stringify(Object.fromEntries(Object.entries(localStorage)))}`
            ];

            const filename = `Bloxd账号_${safeFileName(userName)}_${timestamp()}.txt`;
            downloadText(filename, lines.join('\n'));

            const ok = !!sid.value;
            alert(
                (ok
                    ? `已触发下载：${filename}\n\n找到 Cookie：${sid.name}\n用户：${userName || '未知'}`
                    : `已触发下载：${filename}\n\n⚠ 没找到 3PSIDMC 系列 Cookie。\n已改为保存全量 Cookie，请查看 txt 里的“全量Cookie”行。\n用户名：${userName || '未知'}`)
                + '\n\n（若浏览器询问保存位置，请选择后确认）'
            );
        });

        // ---- 上传本地账号 ----
        const uploadBtn = createButton('上传本地的账号', () => {
            const box = document.createElement('div');
            box.style.cssText = popup.style.cssText + 'width:360px;';
            box.style.transform = 'translate(-50%, -50%)';

            const label = document.createElement('div');
            label.style.cssText = 'color:#fff;font-size:13px;margin-bottom:8px;';
            label.textContent = '请输入新的 Secure-3PSIDMC：';
            box.appendChild(label);

            const input = document.createElement('input');
            input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px;margin-bottom:10px;';
            box.appendChild(input);

            const fileTip = document.createElement('div');
            fileTip.style.cssText = 'color:#ccc;font-size:12px;margin:6px 0;';
            fileTip.textContent = '或从之前保存的 txt 导入：';
            box.appendChild(fileTip);

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.txt,text/plain';
            fileInput.style.cssText = 'margin-bottom:10px;font-size:12px;';
            fileInput.addEventListener('change', () => {
                const f = fileInput.files && fileInput.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const txt = String(reader.result || '');
                    const m = txt.match(/Secure-3PSIDMC:\s*(\S+)/);
                    if (m && m[1]) {
                        input.value = m[1];
                        alert('已从文件读取到 Secure-3PSIDMC');
                    } else {
                        alert('文件中未找到 "Secure-3PSIDMC:" 字段');
                    }
                };
                reader.readAsText(f, 'utf-8');
            });
            box.appendChild(fileInput);

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-around;gap:10px;margin-top:6px;';

            const confirmBtn = createButton('确定', () => {
                const val = (input.value || '').trim();
                if (!val) { alert('内容为空，未做任何修改'); return; }

                // 用备份时记录的名字写入，找不到就按两个下划线写
                const target = getCookie('___Secure-3PSIDMC') !== null
                    ? '___Secure-3PSIDMC'
                    : '__Secure-3PSIDMC';

                // __Secure- 前缀必须带 Secure 属性，否则浏览器拒绝写入
                document.cookie = `${target}=${val}; path=/; Secure; SameSite=None;`;

                const written = getCookie(target) === val;
                alert(written
                    ? '账号信息已写入！刷新页面后生效。'
                    : '写入未生效，请检查是否开启了第三方 Cookie 拦截，或改用 F12 → Application → Cookies 手动粘贴。');
                box.remove();
            });

            const cancelBtn = createButton('取消', () => box.remove());

            row.appendChild(confirmBtn);
            row.appendChild(cancelBtn);
            box.appendChild(row);
            document.body.appendChild(box);
        });

        btnBox.appendChild(saveBtn);
        btnBox.appendChild(uploadBtn);
        document.body.appendChild(popup);
    }

    // ============ 启动 ============
    if (window.location.hostname.indexOf('bloxd.io') !== -1) {
        if (document.body) {
            buildUI();
        } else {
            window.addEventListener('DOMContentLoaded', buildUI);
        }
    }
})();
