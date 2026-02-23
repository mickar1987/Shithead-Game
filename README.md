# 🃏 Shithead Pro — הוראות התקנה על VPS

## 1. התקנת Node.js (אם אין)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # אמור להציג v20.x
```

## 2. העלאת הקבצים ל-VPS

העתק את התיקייה `shithead-server` ל-VPS שלך:
```bash
scp -r shithead-server/ user@YOUR_VPS_IP:~/
```

או ב-FileZilla/SFTP לתיקייה `/home/user/shithead-server/`

## 3. התקנת dependencies

```bash
cd ~/shithead-server
npm install
```

## 4. הפעלה

### הפעלה פשוטה (לבדיקה):
```bash
node server.js
```

### הפעלה תמידית עם PM2 (מומלץ):
```bash
npm install -g pm2
pm2 start server.js --name shithead
pm2 startup    # כדי שיעלה אוטומטית ב-reboot
pm2 save
```

## 5. פתיחת פורט בפיירוול

```bash
sudo ufw allow 3000
```

אם יש לך Nginx/Apache — אפשר לעשות reverse proxy:
```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## 6. גישה למשחק

פתח בדפדפן:
```
http://YOUR_VPS_IP:3000
```

שחקנים אחרים מתחברים לאותה כתובת מהטלפון.

## מבנה הקבצים

```
shithead-server/
├── server.js        ← השרת
├── package.json
└── public/
    └── index.html   ← ה-client (נטען אוטומטית)
```

## איך משחקים?

1. שחקן אחד לוחץ **🌐 אונליין** → **➕ צור חדר** → בוחר מספר שחקנים
2. מקבל **קוד חדר** של 4 אותיות
3. שולח את הקוד לשאר השחקנים
4. כל שחקן נכנס לאותה כתובת, לוחץ **🔗 הצטרף לחדר** ומכניס את הקוד
5. המשחק מתחיל אוטומטית כשכולם נכנסו!
