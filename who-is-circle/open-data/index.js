/**
 * 开放数据域 —— P1 骨架（占位）
 *
 * 开放数据域是一个**独立的 JS 沙盒**：
 *   - 只有它能调 wx.getFriendCloudStorage / wx.getUserCloudStorage / wx.getGroupCloudStorage
 *     （好友昵称、头像、分数这些关系链数据，主域一律读不到）
 *   - 它画出来的东西，主域只能通过 sharedCanvas 看到 —— 不能把对象传回去
 *
 * P1 只验证"这条路通不通"：这里画一块占位内容，主域把它贴到首页。
 * 真正的榜单渲染在 P4；主域与开放数据域的通信协议在 P3/P4 定稿。
 *
 * 沙盒限制（踩过就记住）：
 *   - 不能 require 主域模块，也没有 getApp
 *   - 不能发网络请求（无 wx.request）
 *   - 不能加载远程 http/https 图片，只能用本地相对路径资源
 *
 * 本文件不得引用主域的任何符号 —— 开放数据域与主域是两个世界。
 */
(function () {
  'use strict';

  // 占位内容的设计尺寸（与主域 CFG.OD_PLACEHOLDER 的比例一致；
  // 主域按 sharedCanvas 的实际宽高比等比居中贴入，因此这里不必与主域逐位对齐）
  var W = 500;
  var H = 96;

  function getDpr() {
    try {
      if (typeof wx.getSystemInfoSync === 'function') {
        var info = wx.getSystemInfoSync();
        if (info && info.pixelRatio) return info.pixelRatio;
      }
    } catch (e) { /* 拿不到就用 1 */ }
    return 1;
  }

  function draw() {
    var canvas = wx.getSharedCanvas();
    var dpr = getDpr();

    // 离屏画布按物理像素建，再用 dpr 缩放坐标系 —— 这样文字和描边在高分屏上不糊
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 底：深色底块（首页是暖纸色，刻意用高对比色，一眼能看出"这块来自开放数据域"）
    ctx.fillStyle = '#1F3A5F';
    ctx.fillRect(0, 0, W, H);

    // 描边
    ctx.strokeStyle = '#7FD1FF';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

    // 文字
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('好友榜 · P1 占位', W / 2, H / 2 - 11);

    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#9FC9F0';
    ctx.fillText('开放数据域通路已打通', W / 2, H / 2 + 24);
  }

  function safeDraw() {
    try {
      draw();
    } catch (e) {
      // 开放数据域里的异常不会波及主域，但记一笔便于排查
      console.error('[open-data] 占位绘制失败：', e);
    }
  }

  safeDraw();

  // P4 会用主域 postMessage 驱动重绘（数据变了要重画）
  if (typeof wx.onMessage === 'function') {
    wx.onMessage(function (msg) {
      if (!msg || msg.type !== 'redraw') return;
      safeDraw();
    });
  }
})();
