# CloudFTP - Online Web FTP İstemcisi

Modern, hızlı ve güvenli web tabanlı FTP / FTPS istemcisi. Google Cloud Run üzerinde sunucusuz (serverless) olarak çalışmak üzere tasarlanmıştır.

## Özellikler

- **Hızlı Bağlantı**: FTP ve güvenli FTPS (TLS/SSL) protokol desteği.
- **Dosya Gezgini**: Ağaç yapısı, ekmek kırıntısı (breadcrumb) navigasyonu, arama/filtreleme.
- **Dosya Yükleme & İndirme**: Sürükle-bırak (Drag & Drop) ve ilerleme çubuğu ile çoklu dosya yükleme, doğrudan HTTP stream ile hızlı indirme.
- **Dahili Kod ve Metin Editörü**: HTML, CSS, JS, PHP, Python, JSON ve metin dosyalarını tarayıcıda düzenleyip doğrudan FTP'ye geri kaydetme.
- **Resim Önizleme**: JPG, PNG, GIF, SVG, WEBP resim formatlarını indirmeden tarayıcıda önizleme.
- **Dosya Yönetimi**: Klasör oluşturma, yeni dosya oluşturma, yeniden adlandırma, dosya/klasör silme.
- **İzin Yönetimi (CHMOD)**: Grafiksel veya sayısal (örn: 755, 644) dosya izinlerini değiştirme.
- **Sunucu & Komut Günlüğü (Log Console)**: FileZilla benzeri gerçek zamanlı komut ve durum akışı.
- **Kayıtlı Sunucular (Yer İmleri)**: Sık kullanılan FTP bağlantı bilgilerini tarayıcıda güvenle saklama.

## Kurulum ve Yerel Çalıştırma

```bash
# Bağımlılıkları yükleyin
npm install

# Geliştirme sunucusunu başlatın
npm start
```

Tarayıcınızda `http://localhost:8080` adresini açın.

## Google Cloud Run Dağıtımı

```bash
gcloud run deploy ftp-client-online \
  --source . \
  --project adilyildiz \
  --region europe-west3 \
  --allow-unauthenticated
```

