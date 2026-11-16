# Hasbihal

Hesaplı, çevrimiçi küçük bir sosyal ağ. E-posta ile kayıt, Google ile giriş, gönderi, beğeni, yorum, etiket ve arama var. Veriler SQLite dosyasında saklanır.

## Gereksinimler

- Node.js **22.5 veya üstü** (`node -v` ile bak)
- Node çalıştırabilen bir sunucu. Sadece HTML yüklenen paylaşımlı hosting (cPanel vb.) **çalışmaz**, çünkü hesaplar ve gönderiler sunucu tarafında tutulur.

## Kendi bilgisayarında deneme

```bash
npm install
npm start
```

Sonra tarayıcıda http://localhost:3000 adresini aç.

## Ayarlar (.env)

`.env.example` dosyasını `.env` olarak kopyala ve doldur.

| Değişken | Ne işe yarar |
|---|---|
| `PORT` | Sunucunun portu (varsayılan 3000) |
| `NODE_ENV=production` | Canlıda mutlaka yaz. Çerezleri yalnızca HTTPS üzerinden gönderir. |
| `GOOGLE_CLIENT_ID` | Doluysa "Google ile devam et" düğmesi görünür |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Doluysa giriş ve kayıtta Cloudflare robot doğrulaması açılır |
| `TRUST_PROXY=1` | Nginx, Cloudflare gibi bir proxy arkasındaysan yaz. Yoksa hız sınırı herkesi aynı kişi sayar. |
| `DB_PATH` | Veritabanı dosyasının yeri (varsayılan `data/hasbihal.db`) |

## Google ile giriş nasıl açılır

1. https://console.cloud.google.com adresinde bir proje oluştur.
2. **APIs & Services → OAuth consent screen** bölümünde uygulama adını (Hasbihal) ve e-postanı gir.
3. **Credentials → Create credentials → OAuth client ID → Web application** seç.
4. **Authorized JavaScript origins** alanına sitenin adresini ekle (örn. `https://siteadin.com`). Denemek için `http://localhost:3000` de ekleyebilirsin.
5. Çıkan **Client ID** değerini `.env` içindeki `GOOGLE_CLIENT_ID` satırına yapıştır, sunucuyu yeniden başlat.

Sadece e-postası Google tarafından doğrulanmış hesaplar kabul edilir.

## Bot koruması

Ne var:

- Kayıt formunda görünmeyen tuzak alan ve "form çok hızlı gönderildi" kontrolü
- IP başına giriş, kayıt ve genel istek sınırı; kullanıcı başına gönderi ve yorum sınırı
- Gönderileri görmek için giriş şart (toplu veri çeken botları zorlaştırır)
- Google ile giriş (gerçek Google hesabı gerektirir)
- İsteğe bağlı **Cloudflare Turnstile** (ücretsiz, görünmez CAPTCHA)

Turnstile açmak için: https://dash.cloudflare.com → **Turnstile → Add site**. Verilen "site key" ve "secret key" değerlerini `.env` dosyasına yaz. Canlıya çıkarken bunu açmanı öneririm.

Henüz yok: e-posta doğrulama ve "şifremi unuttum". İkisi de e-posta gönderen bir servis (SMTP, Resend, vb.) ister. Bir sonraki adım olarak eklenebilir.

## Canlıya alma (VPS örneği)

```bash
# sunucuda
npm install --omit=dev
cp .env.example .env     # düzenle: NODE_ENV=production, TRUST_PROXY=1, anahtarlar
npm install -g pm2
pm2 start server.js --name hasbihal
pm2 save && pm2 startup
```

Önüne Nginx (veya Caddy) koyup HTTPS sertifikası al (Let's Encrypt ücretsiz). Nginx ayarında isteği `http://127.0.0.1:3000` adresine yönlendir.

Render, Railway, Fly.io gibi servislerde de çalışır. Dikkat: `data/` klasörü kalıcı bir diskte olmalı, yoksa her güncellemede veriler silinir.

**Yedek:** `data/` klasörünü düzenli olarak kopyala.

## Dosyalar

- `server.js`: sunucu, API, güvenlik
- `public/index.html`, `public/style.css`, `public/app.js`: arayüz
- `data/`: veritabanı (ilk çalıştırmada oluşur)
