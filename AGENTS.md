# AGENTS.md — GitHub Repo Organizer

## RELEASE KURALI (ZORUNLU / her değişiklikten sonra)

Kod/UI'da kullanıcı için anlamlı **her değişiklikten sonra** aşağıdaki 5 adım
SIRAYLA uygulanır. Tek komutla: `./release.sh <version> "<commit mesajı>"`

1. **GitHub'a pushla** — değişiklikleri commit'le ve `origin main`'e gönder.
2. **EXE olarak derle** — `npm run build` (electron-builder, Windows NSIS x64).
   Çıktı: `dist/GitHub Repo Organizer Setup <version>.exe`
3. **EXE'yi kur** — üretilen installer'ı çalıştır (NSIS sihirbazı GUI).
4. **Release'i GitHub'a yükle** — `gh release create v<version>` ile
   `.exe`, `.exe.blockmap` ve `latest.yml` asset'lerini yükle.
   - Aynı sürüm yeniden yayınlanıyorsa önce eski release + tag silinir
     (`gh release delete v<version> --yes --cleanup-tag`).
5. **Web sayfasını güncelle** — `C:\Users\umuti\Projects\github-repo-cleaner-ai_web_page`
   içinde changelog / sürüm / indirme linklerini güncelle ve `main`'e pushla
   (Vercel otomatik redeploy eder).

### Sürüm notları
- `package.json` içindeki `version` tek doğru kaynaktır; uygulama sürümü
  `getAppVersion` IPC'si ile buradan okunur (statusbar + sidebar).
- Web sayfasındaki indirme linkleri sürüm numarasına bağlıdır
  (`src/pages/Index.tsx`, `src/pages/Changelog.tsx`).
- Sürüm yükseltirken önce `package.json`'u güncelle, sonra `release.sh`'i
  yeni sürümle çalıştır.

### Repolar
- Uygulama: https://github.com/palamut62/github-repo-cleaner-ai
- Web sayfası: https://github.com/palamut62/github-repo-cleaner-ai_web_page
  (canlı: https://github-repo-cleaner-aiwebpage.vercel.app)

## UI Kuralı
- Native tarayıcı dialogları (`alert`/`confirm`/`prompt`) YASAK; daima
  uygulama-içi modal/toast bileşeni kullan.
