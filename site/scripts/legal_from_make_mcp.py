"""One-off: derive Andon Deck's legal pages from make-mcp.net's, per language.

Generic swaps cover name, contact, licence and link examples. The paragraphs
that describe the software itself are replaced outright, since they describe a
different product.
"""
import re, sys, pathlib

SRC = pathlib.Path(sys.argv[1])          # folder with make-mcp legal pages
OUT = pathlib.Path(sys.argv[2])          # site/src/legal

SOFTWARE_IMPRESSUM = {
 "en": "<p>Andon Deck is open source under the MIT license; the source code is published on GitHub. The software is provided without warranty under the terms of the MIT license. The project is not affiliated with Anthropic, Elgato or Corsair.</p>",
 "de": "<p>Andon Deck ist Open Source unter der MIT-Lizenz; der Quellcode ist auf GitHub veröffentlicht. Die Software wird ohne Gewährleistung bereitgestellt; es gelten die Bedingungen der MIT-Lizenz. Das Projekt steht in keiner Verbindung zu Anthropic, Elgato oder Corsair.</p>",
 "zh": "<p>Andon Deck 以 MIT 许可证开源，源代码发布在 GitHub 上。本软件按 MIT 许可证条款提供，不附带任何担保。本项目与 Anthropic、Elgato 或 Corsair 没有任何关联。</p>",
 "es": "<p>Andon Deck es software libre bajo la licencia MIT; el código fuente está publicado en GitHub. El software se ofrece sin garantía según los términos de la licencia MIT. El proyecto no está vinculado a Anthropic, Elgato ni Corsair.</p>",
 "fr": "<p>Andon Deck est un logiciel libre sous licence MIT ; le code source est publié sur GitHub. Le logiciel est fourni sans garantie, selon les termes de la licence MIT. Le projet n'est affilié ni à Anthropic, ni à Elgato, ni à Corsair.</p>",
 "it": "<p>Andon Deck è open source con licenza MIT; il codice sorgente è pubblicato su GitHub. Il software è fornito senza garanzia secondo i termini della licenza MIT. Il progetto non è affiliato ad Anthropic, Elgato o Corsair.</p>",
 "ru": "<p>Andon Deck — программа с открытым исходным кодом под лицензией MIT; исходный код опубликован на GitHub. Программа предоставляется без гарантий на условиях лицензии MIT. Проект не связан с Anthropic, Elgato или Corsair.</p>",
}

SOFTWARE_PRIVACY = {
 "en": ("The Andon Deck software", "Andon Deck runs entirely on your computer and talks to Claude Code over a local port. There is no central service and no usage data is sent to me. It reads Claude Code's local transcripts only to show your usage history on the deck and never uploads them."),
 "de": ("Die Software Andon Deck", "Andon Deck läuft vollständig auf Ihrem Rechner und spricht über einen lokalen Port mit Claude Code. Es gibt keinen zentralen Dienst und es werden keine Nutzungsdaten an mich übertragen. Die lokalen Transkripte von Claude Code werden nur gelesen, um den Nutzungsverlauf auf dem Deck anzuzeigen, und niemals hochgeladen."),
 "zh": ("Andon Deck 软件", "Andon Deck 完全在你的电脑上运行，通过本地端口与 Claude Code 通信。没有任何中央服务，也不会向我发送任何使用数据。它只读取 Claude Code 的本地会话记录，用于在设备上显示使用历史，从不上传。"),
 "es": ("El software Andon Deck", "Andon Deck se ejecuta íntegramente en tu ordenador y se comunica con Claude Code a través de un puerto local. No hay ningún servicio central y no se me envía ningún dato de uso. Solo lee las transcripciones locales de Claude Code para mostrar tu historial de uso en el deck y nunca las sube."),
 "fr": ("Le logiciel Andon Deck", "Andon Deck fonctionne entièrement sur votre ordinateur et communique avec Claude Code via un port local. Il n'y a aucun service central et aucune donnée d'utilisation ne m'est transmise. Il lit les transcriptions locales de Claude Code uniquement pour afficher votre historique d'utilisation sur le deck et ne les envoie jamais."),
 "it": ("Il software Andon Deck", "Andon Deck funziona interamente sul tuo computer e comunica con Claude Code tramite una porta locale. Non esiste alcun servizio centrale e nessun dato di utilizzo viene inviato a me. Legge le trascrizioni locali di Claude Code solo per mostrare la cronologia di utilizzo sul deck e non le carica mai."),
 "ru": ("Программа Andon Deck", "Andon Deck работает полностью на вашем компьютере и связывается с Claude Code через локальный порт. Центрального сервиса нет, и никакие данные об использовании мне не передаются. Программа читает локальные журналы Claude Code только для того, чтобы показать историю использования на устройстве, и никогда их не выгружает."),
}

def body(path):
    html = path.read_text(encoding="utf-8")
    inner = re.search(r'<main class="wrap legal">(.*?)</main>', html, re.S).group(1)
    inner = re.sub(r'<p class="hint legal-langs">.*?</p>', "", inner, flags=re.S)
    return inner.strip()

def common(html):
    html = html.replace("support@make-mcp.net", "support@andondeck.com")
    html = html.replace("make-mcp.net", "andondeck.com")
    html = html.replace("Apache-2.0", "MIT")
    html = re.sub(r"\bnpm\b", "Elgato Marketplace", html)
    return html.replace("make-mcp", "Andon Deck")

for code in ["en", "de", "zh", "es", "fr", "it", "ru"]:
    suffix = "" if code == "de" else f".{code}"
    out = OUT / code
    out.mkdir(parents=True, exist_ok=True)

    imp = body(SRC / f"impressum{suffix}.html")
    # The software paragraph is the last paragraph of the Impressum.
    paras = list(re.finditer(r"<p>.*?</p>", imp, re.S))
    last = paras[-1]
    imp = imp[: last.start()] + SOFTWARE_IMPRESSUM[code] + imp[last.end():]
    (out / "impressum.html").write_text(common(imp) + "\n", encoding="utf-8")

    dat = body(SRC / f"datenschutz{suffix}.html")
    # The section whose heading names make-mcp describes the software itself.
    m = re.search(r"<h2>[^<]*make-mcp[^<]*</h2>\s*<p>.*?</p>", dat, re.S)
    if not m:
        sys.exit(f"{code}: software section not found")
    head, text = SOFTWARE_PRIVACY[code]
    dat = dat[: m.start()] + f"<h2>{head}</h2>\n<p>{text}</p>" + dat[m.end():]
    dat = common(dat)
    if "make-mcp" in dat or "Cursor" in dat:
        sys.exit(f"{code}: leftover make-mcp text")
    (out / "datenschutz.html").write_text(dat + "\n", encoding="utf-8")
    print(code, "ok")
