# 联机部署指南

游戏的服务端仍然是**零依赖**的纯 Node 进程：静态文件 + 存档接口 + 一个手写的 WebSocket（`net/ws.js`，没有引入 ws 库）。
所以部署只要机器上有 Node 18+ 就能跑，不需要 `npm install`。

---

## 一、本地局域网（和朋友在同一 Wi-Fi 下玩）

```bash
node server.js
```

启动时终端会打印两个地址：

```
本机打开：http://localhost:4321
局域网：http://192.168.x.x:4321   （手机连同一个 Wi-Fi 用这个）
```

- 电脑和手机连同一个路由器，手机浏览器打开「局域网」那行地址即可。
- 点标题页的 **联机同屏** → 输入名字 → 进入同一座地牢。最多 4 人。
- 手机端（APK 或浏览器都行）：**在昵称框下面的「服务器地址」栏填这台电脑的局域网地址**，例如 `192.168.1.20:4321`，
  留空则连当前页面所在的服务器。填完点「进入地牢」即可加入。
- 连不上通常是 Windows 防火墙拦了 4321 端口：允许 Node 通过专用网络即可。

---

## 二、云服务器（公网可玩）

### 1. 上传代码

只需要这些文件/目录：

```
server.js  package.json
src/  public/  net/
```

```bash
scp -r server.js package.json src public net user@your-server:/opt/dungeon-rpg/
```

服务器上装 Node（18+）：

```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. 直接跑起来看看

```bash
cd /opt/dungeon-rpg
PORT=8080 node server.js
```

浏览器打开 `http://服务器IP:8080` 能进游戏就说明通了。

### 3. 用 systemd 常驻

`/etc/systemd/system/dungeon-rpg.service`

```ini
[Unit]
Description=Dungeon Pixel RPG
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/dungeon-rpg
Environment=PORT=8080
Environment=NO_OPEN=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dungeon-rpg
sudo systemctl status dungeon-rpg      # 看状态
sudo journalctl -u dungeon-rpg -f      # 看日志
```

### 4. Nginx 反向代理（要 https 才建议对外）

联机走 WebSocket，反代必须带 `Upgrade` 头，否则会一直连不上：

```nginx
server {
    listen 80;
    server_name game.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # WebSocket 必需的三个头
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
```

配 https 用 certbot 一行就行：`sudo certbot --nginx -d game.example.com`。
页面上会按 `location.protocol` 自动选 `ws://` 还是 `wss://`，不用改代码。

### 5. 防火墙

```bash
sudo ufw allow 80,443/tcp     # 用 nginx 时只开这两个
# 如果不用 nginx、直接暴露 8080：
sudo ufw allow 8080/tcp
```

云厂商控制台的安全组也要放行对应端口。

---

## 三、联机是怎么实现的（改代码前先看这段）

- **服务器权威**：`net/room.js` 里跑唯一一份 `Engine.World`，60Hz 推进；客户端只上报输入。
  这样不存在两端状态分叉，也不怕改客户端作弊。
- **快照同步**：服务器 20Hz 把「玩家 / 怪物 / 物品 / 弹道」打包发给房间里所有人；客户端把它塞进一个本地影子 world，
  复用原来的渲染代码（`draw()` 一行没改，只是多了队友的绘制）。
- **视野**：地图只在地图变化时发一次（`map` 消息），可见性由各客户端本地算（`world.updateFov()`），省带宽。
- **成长共享**：经验每个活着的玩家都拿一份；升级三选一是**全队共享一次选择**，效果同时加给所有人。
  背包、血量、金币、武器是**各人各的**。
- **倒下**：一名玩家倒下不会结束游戏，其余队友还能继续；全灭才结算。下一层开局全员复活。
- **房间**：v1 只有一个大厅，满 4 人自动开新房间；空房自动销毁。

### 已知限制（后续要做的）

1. 没有客户端预测，网络延迟高时自己的人物会有 ~50ms 的跟手延迟。
2. 没有断线重连：掉线后需要重新加入（会作为新人加入当前房间）。
3. 商店/宝箱的库存是共享的，谁先买谁得。
4. 没有匹配与密码房，任何拿到地址的人都能进。

**掉线是会自动清理的**：服务端每 15 秒发一次 WebSocket ping，连续两轮没有 pong 就断开连接并把人从房间里摘掉
（手机切后台、断 Wi-Fi 这类"TCP 没关但人已经没了"的情况会在 30 秒内被清走）。
