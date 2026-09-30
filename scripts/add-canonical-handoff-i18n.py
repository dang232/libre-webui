#!/usr/bin/env python3
"""Insert the Auth handoff i18n keys into every locale file.

Libre's AGENTS.md requires every user-visible string to be present and non-empty
in all files under frontend/src/i18n/locales/, and the tree currently holds 100%
key parity across 25 locales. New keys therefore have to land everywhere, not
just behind a t(key, default) fallback.
"""
import io
import json
import os

T = {
    "en": {
        "callback": {
            "failedTitle": "Sign-in could not be completed",
            "expired": "This sign-in link expired. Please try again.",
            "invalid": "This sign-in link is no longer valid. Please start again.",
            "backToLogin": "Back to sign in",
            "working": "Signing you in…",
            "workingHint": "Please wait while we finish.",
        },
        "canonical": {
            "redirecting": "Redirecting…",
            "signIn": "Continue with ALcore",
        },
    },
    "ar": {
        "callback": {
            "failedTitle": "تعذّر إكمال تسجيل الدخول",
            "expired": "انتهت صلاحية رابط تسجيل الدخول. يرجى المحاولة مرة أخرى.",
            "invalid": "لم يعد رابط تسجيل الدخول صالحًا. يرجى البدء من جديد.",
            "backToLogin": "العودة إلى تسجيل الدخول",
            "working": "جارٍ تسجيل دخولك…",
            "workingHint": "يرجى الانتظار حتى ينتهي الأمر.",
        },
        "canonical": {"redirecting": "جارٍ إعادة التوجيه…", "signIn": "المتابعة بحساب ALcore"},
    },
    "bn": {
        "callback": {
            "failedTitle": "সাইন-ইন সম্পন্ন করা যায়নি",
            "expired": "এই সাইন-ইন লিঙ্কের মেয়াদ শেষ হয়েছে। আবার চেষ্টা করুন।",
            "invalid": "এই সাইন-ইন লিঙ্কটি আর বৈধ নয়। আবার শুরু করুন।",
            "backToLogin": "সাইন-ইন-এ ফিরে যান",
            "working": "আপনাকে সাইন ইন করা হচ্ছে…",
            "workingHint": "সম্পন্ন হওয়া পর্যন্ত অপেক্ষা করুন।",
        },
        "canonical": {
            "redirecting": "পুনর্নির্দেশ করা হচ্ছে…",
            "signIn": "ALcore অ্যাকাউন্ট দিয়ে চালিয়ে যান",
        },
    },
    "cs": {
        "callback": {
            "failedTitle": "Přihlášení se nepodařilo dokončit",
            "expired": "Platnost tohoto odkazu pro přihlášení vypršela. Zkuste to prosím znovu.",
            "invalid": "Tento odkaz pro přihlášení už není platný. Začněte prosím znovu.",
            "backToLogin": "Zpět na přihlášení",
            "working": "Přihlašujeme vás…",
            "workingHint": "Počkejte prosím, dokud nebude hotovo.",
        },
        "canonical": {
            "redirecting": "Přesměrování…",
            "signIn": "Pokračovat s účtem ALcore",
        },
    },
    "da": {
        "callback": {
            "failedTitle": "Login kunne ikke gennemføres",
            "expired": "Dette loginlink er udløbet. Prøv igen.",
            "invalid": "Dette loginlink er ikke længere gyldigt. Start igen.",
            "backToLogin": "Tilbage til login",
            "working": "Logger dig ind…",
            "workingHint": "Vent venligst, mens vi er færdige.",
        },
        "canonical": {
            "redirecting": "Omdirigerer…",
            "signIn": "Fortsæt med ALcore-konto",
        },
    },
    "de": {
        "callback": {
            "failedTitle": "Anmeldung konnte nicht abgeschlossen werden",
            "expired": "Dieser Anmeldelink ist abgelaufen. Bitte versuchen Sie es erneut.",
            "invalid": "Dieser Anmeldelink ist nicht mehr gültig. Bitte beginnen Sie erneut.",
            "backToLogin": "Zurück zur Anmeldung",
            "working": "Sie werden angemeldet…",
            "workingHint": "Bitte warten, bis wir fertig sind.",
        },
        "canonical": {
            "redirecting": "Weiterleitung…",
            "signIn": "Mit ALcore-Konto fortfahren",
        },
    },
    "es": {
        "callback": {
            "failedTitle": "No se pudo completar el inicio de sesión",
            "expired": "Este enlace de inicio de sesión ha caducado. Inténtalo de nuevo.",
            "invalid": "Este enlace de inicio de sesión ya no es válido. Vuelve a empezar.",
            "backToLogin": "Volver al inicio de sesión",
            "working": "Iniciando sesión…",
            "workingHint": "Espera mientras terminamos.",
        },
        "canonical": {
            "redirecting": "Redirigiendo…",
            "signIn": "Continuar con la cuenta de ALcore",
        },
    },
    "fr": {
        "callback": {
            "failedTitle": "La connexion n'a pas pu aboutir",
            "expired": "Ce lien de connexion a expiré. Veuillez réessayer.",
            "invalid": "Ce lien de connexion n'est plus valide. Veuillez recommencer.",
            "backToLogin": "Retour à la connexion",
            "working": "Connexion en cours…",
            "workingHint": "Veuillez patienter pendant que nous finalisons.",
        },
        "canonical": {
            "redirecting": "Redirection…",
            "signIn": "Continuer avec le compte ALcore",
        },
    },
    "hi": {
        "callback": {
            "failedTitle": "साइन इन पूरा नहीं हो सका",
            "expired": "यह साइन इन लिंक समाप्त हो गया है। कृपया फिर से प्रयास करें।",
            "invalid": "यह साइन इन लिंक अब मान्य नहीं है। कृपया फिर से शुरू करें।",
            "backToLogin": "साइन इन पर वापस जाएँ",
            "working": "आपको साइन इन किया जा रहा है…",
            "workingHint": "कृपया हमारा काम पूरा होने तक प्रतीक्षा करें।",
        },
        "canonical": {
            "redirecting": "रीडायरेक्ट किया जा रहा है…",
            "signIn": "ALcore खाते के साथ जारी रखें",
        },
    },
    "id": {
        "callback": {
            "failedTitle": "Tidak dapat menyelesaikan proses masuk",
            "expired": "Tautan masuk ini telah kedaluwarsa. Silakan coba lagi.",
            "invalid": "Tautan masuk ini tidak lagi valid. Silakan mulai lagi.",
            "backToLogin": "Kembali ke halaman masuk",
            "working": "Sedang masuk…",
            "workingHint": "Harap tunggu sebentar.",
        },
        "canonical": {
            "redirecting": "Mengalihkan…",
            "signIn": "Lanjutkan dengan akun ALcore",
        },
    },
    "is": {
        "callback": {
            "failedTitle": "Innskráningin ekki framkvæmd",
            "expired": "Þessi innskráningartenging er útrunnin. Reyndu aftur.",
            "invalid": "Þessi innskráningartenging er ekki lengur gilt. Byrjaðu aftur.",
            "backToLogin": "Til baka í innskráningu",
            "working": "Skráir þig inn…",
            "workingHint": "Bíðu þar til við klárum.",
        },
        "canonical": {"redirecting": "Endurvís…", "signIn": "Halda áfram með ALcore aðgangi"},
    },
    "it": {
        "callback": {
            "failedTitle": "Impossibile completare l'accesso",
            "expired": "Questo link di accesso è scaduto. Riprova.",
            "invalid": "Questo link di accesso non è più valido. Ricomincia.",
            "backToLogin": "Torna all'accesso",
            "working": "Accesso in corso…",
            "workingHint": "Attendi qualche istante.",
        },
        "canonical": {
            "redirecting": "Reindirizzamento…",
            "signIn": "Continua con l'account ALcore",
        },
    },
    "ja": {
        "callback": {
            "failedTitle": "サインインを完了できませんでした",
            "expired": "このサインインリンクの有効期限が切れています。もう一度お試しください。",
            "invalid": "このサインインリンクは無効になりました。最初からやり直してください。",
            "backToLogin": "サインインに戻る",
            "working": "サインインしています…",
            "workingHint": "しばらくお待ちください。",
        },
        "canonical": {
            "redirecting": "リダイレクトしています…",
            "signIn": "ALcore アカウントで続行",
        },
    },
    "ko": {
        "callback": {
            "failedTitle": "로그인을 완료할 수 없습니다",
            "expired": "이 로그인 링크가 만료되었습니다. 다시 시도해 주세요.",
            "invalid": "이 로그인 링크는 더 이상 유효하지 않습니다. 처음부터 다시 시도해 주세요.",
            "backToLogin": "로그인으로 돌아가기",
            "working": "로그인 중입니다…",
            "workingHint": "잠시 기다려 주세요.",
        },
        "canonical": {
            "redirecting": "리디렉션 중…",
            "signIn": "ALcore 계정으로 계속",
        },
    },
    "ms": {
        "callback": {
            "failedTitle": "Log masuk tidak dapat diselesaikan",
            "expired": "Pautan log masuk ini telah tamat tempoh. Sila cuba lagi.",
            "invalid": "Pautan log masuk ini tidak lagi sah. Sila mulakan semula.",
            "backToLogin": "Kembali ke log masuk",
            "working": "Sedang log masuk…",
            "workingHint": "Sila tunggu sebentar.",
        },
        "canonical": {
            "redirecting": "Mengalihkan…",
            "signIn": "Teruskan dengan akaun ALcore",
        },
    },
    "nl": {
        "callback": {
            "failedTitle": "Aanmelden kon niet worden voltooid",
            "expired": "Deze aanmeldlink is verlopen. Probeer het opnieuw.",
            "invalid": "Deze aanmeldlink is niet langer geldig. Begin opnieuw.",
            "backToLogin": "Terug naar aanmelden",
            "working": "Bezig met aanmelden…",
            "workingHint": "Even geduld, we zijn bijna klaar.",
        },
        "canonical": {
            "redirecting": "Doorsturen…",
            "signIn": "Doorgaan met ALcore-account",
        },
    },
    "pl": {
        "callback": {
            "failedTitle": "Nie udało się zakończyć logowania",
            "expired": "Ten link logowania wygasł. Spróbuj ponownie.",
            "invalid": "Ten link logowania jest już nieaktualny. Zacznij od nowa.",
            "backToLogin": "Powrót do logowania",
            "working": "Logowanie…",
            "workingHint": "Poczekaj, aż zakończymy.",
        },
        "canonical": {
            "redirecting": "Przekierowywanie…",
            "signIn": "Kontynuuj kontem ALcore",
        },
    },
    "pt": {
        "callback": {
            "failedTitle": "Não foi possível concluir o login",
            "expired": "Este link de login expirou. Tente novamente.",
            "invalid": "Este link de login não é mais válido. Comece novamente.",
            "backToLogin": "Voltar ao login",
            "working": "A iniciar sessão…",
            "workingHint": "Aguarde enquanto concluímos.",
        },
        "canonical": {
            "redirecting": "A redirecionar…",
            "signIn": "Continuar com a conta ALcore",
        },
    },
    "ru": {
        "callback": {
            "failedTitle": "Не удалось выполнить вход",
            "expired": "Срок действия этой ссылки для входа истёк. Попробуйте снова.",
            "invalid": "Эта ссылка для входа больше недействительна. Начните заново.",
            "backToLogin": "Вернуться ко входу",
            "working": "Выполняется вход…",
            "workingHint": "Пожалуйста, подождите, пока мы закончим.",
        },
        "canonical": {
            "redirecting": "Перенаправление…",
            "signIn": "Продолжить с учётной записью ALcore",
        },
    },
    "sv": {
        "callback": {
            "failedTitle": "Inloggningen kunde inte slutföras",
            "expired": "Den här inloggningslänken har gått ut. Försök igen.",
            "invalid": "Den här inloggningslänken är inte längre giltig. Börja om.",
            "backToLogin": "Tillbaka till inloggningen",
            "working": "Loggar in…",
            "workingHint": "Vänta medan vi slutför.",
        },
        "canonical": {
            "redirecting": "Omdirigerar…",
            "signIn": "Fortsätt med ALcore-konto",
        },
    },
    "th": {
        "callback": {
            "failedTitle": "ไม่สามารถเข้าสู่ระบบได้",
            "expired": "ลิงก์เข้าสู่ระบบหมดอายุแล้ว กรุณาลองใหม่อีกครั้ง",
            "invalid": "ลิงก์เข้าสู่ระบบไม่ถูกต้องแล้ว กรุณาเริ่มต้นใหม่",
            "backToLogin": "กลับไปหน้าเข้าสู่ระบบ",
            "working": "กำลังเข้าสู่ระบบ…",
            "workingHint": "กรุณารอสักครู่",
        },
        "canonical": {
            "redirecting": "กำลังเปลี่ยนเส้นทาง…",
            "signIn": "ดำเนินการต่อด้วยบัญชี ALcore",
        },
    },
    "tr": {
        "callback": {
            "failedTitle": "Oturum açma tamamlanamadı",
            "expired": "Bu oturum açma bağlantısının süresi doldu. Lütfen tekrar deneyin.",
            "invalid": "Bu oturum açma bağlantısı artık geçerli değil. Lütfen yeniden başlayın.",
            "backToLogin": "Oturum açmaya dön",
            "working": "Oturum açılıyor…",
            "workingHint": "Lütfen tamamlanmasını bekleyin.",
        },
        "canonical": {
            "redirecting": "Yönlendiriliyor…",
            "signIn": "ALcore hesabıyla devam et",
        },
    },
    "uk": {
        "callback": {
            "failedTitle": "Не вдалося завершити вхід",
            "expired": "Термін дії цього посилання для входу минув. Спробуйте ще раз.",
            "invalid": "Це посилання для входу більше недійсне. Почніть спочатку.",
            "backToLogin": "Повернутися до входу",
            "working": "Виконується вхід…",
            "workingHint": "Будь ласка, зачекайте, доки ми завершимо.",
        },
        "canonical": {
            "redirecting": "Перенаправлення…",
            "signIn": "Продовжити з обліковим записом ALcore",
        },
    },
    "vi": {
        "callback": {
            "failedTitle": "Không thể hoàn tất đăng nhập",
            "expired": "Liên kết đăng nhập này đã hết hạn. Vui lòng thử lại.",
            "invalid": "Liên kết đăng nhập này không còn hợp lệ. Vui lòng bắt đầu lại.",
            "backToLogin": "Quay lại đăng nhập",
            "working": "Đang đăng nhập…",
            "workingHint": "Vui lòng đợi trong khi chúng tôi hoàn tất.",
        },
        "canonical": {
            "redirecting": "Đang chuyển hướng…",
            "signIn": "Tiếp tục bằng tài khoản ALcore",
        },
    },
    "zh": {
        "callback": {
            "failedTitle": "无法完成登录",
            "expired": "此登录链接已过期，请重试。",
            "invalid": "此登录链接已无效，请重新开始。",
            "backToLogin": "返回登录",
            "working": "正在登录…",
            "workingHint": "请稍候，正在完成。",
        },
        "canonical": {
            "redirecting": "正在跳转…",
            "signIn": "使用 ALcore 账户继续",
        },
    },
}

BASE = os.path.join("frontend", "src", "i18n", "locales")
updated, missing = [], []

for code, entries in sorted(T.items()):
    path = os.path.join(BASE, f"{code}.json")
    if not os.path.exists(path):
        missing.append(code)
        continue
    with io.open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    auth = data.get("auth")
    if not isinstance(auth, dict):
        missing.append(f"{code}: no auth object")
        continue
    for group, values in entries.items():
        target = auth.get(group)
        if not isinstance(target, dict):
            target = {}
        for key, value in values.items():
            if isinstance(target.get(key), str) and target[key].strip():
                continue  # never clobber an existing translation
            target[key] = value
        auth[group] = target
    # The tree keeps `auth` alphabetically ordered; preserve that.
    data["auth"] = {k: auth[k] for k in sorted(auth)}
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    updated.append(code)

print(f"updated {len(updated)}/{len(T)}: {' '.join(updated)}")
if missing:
    print("MISSING:", missing)
