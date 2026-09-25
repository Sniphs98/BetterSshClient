# Plugin-System: Überlegungen und Vorschlag

> Stand: Auf dem Branch `feat/plugin-system` gibt es einen **Prototyp für Weg B** (Code-Plugins im
> Sandkasten), siehe Abschnitt 10. Abschnitte 1–9 sind die ursprüngliche Überlegung.

## 1. Worum geht es?

Ein Plugin-System heißt: Die App bietet **festgelegte Andockstellen** an, und fremde
Erweiterungen können sich dort einklinken, **ohne dass die App selbst geändert werden
muss**. Wer ein neues Feature will, schreibt ein Plugin statt einen Pull Request.

Die Frage ist nicht nur *wie* man das baut, sondern vor allem *wie viel Macht* ein Plugin
bekommt. Bei einem SSH-Client ist das die zentrale Entscheidung (siehe Abschnitt 4).

## 2. Was die App heute schon „erweiterbar“ macht

Es gibt bereits zwei Stellen, die wie Plugins gebaut sind, nur fest eingebaut:

| Stelle | Datei | Wie es funktioniert |
|---|---|---|
| **Dienst-Erkennung** | `packages/electron/src/core/ssh/services/registry.ts` | Eine Liste von „Providern“ (Docker, nginx, PostgreSQL, Redis, Node.js). Jeder prüft anhand der Probe-Ausgabe (`ps`, `ss`, `systemctl`), ob er auf dem Server läuft, und bekommt dann ein Badge auf der Dashboard-Karte. |
| **Snippet-/Automation-Export** | `packages/electron/src/core/automation/bundle.ts` | Snippets und Automationen lassen sich als JSON-Datei weitergeben und importieren. Das ist im Grunde schon ein „Daten-Plugin“. |

Ein Plugin-System würde diese Listen **öffnen**: Statt nur der fünf eingebauten Dienste
könnten Plugins weitere beisteuern.

## 3. Die drei grundsätzlichen Wege

| | **A: Deklarativ** (nur Daten) | **B: Code im Sandkasten** | **C: Code mit vollem Zugriff** |
|---|---|---|---|
| Was ein Plugin ist | Eine Datei (JSON): Befehle, Erkennungsmuster, Menüeinträge | JavaScript in einem abgeschotteten Prozess, spricht nur über eine freigegebene Schnittstelle mit der App | JavaScript, das im Hauptprozess mit allen Rechten läuft |
| Was damit geht | Snippet-Pakete, neue Dienste erkennen, eigene Dashboard-Werte („zeige Ausgabe von `…`“), Kontextmenü-Aktionen | Eigene Panels und Ansichten, AI-Anbindung, Integrationen (z. B. Passwort-Manager) | Alles |
| Aufwand | **klein** | **groß** | mittel |
| Sicherheit | **sicher**: Es läuft nur, was lesbar in der Datei steht | gut, *wenn* die Schnittstelle sauber gebaut ist | **gefährlich** |
| Vorbilder | VS-Code-Snippets und -Themes, Home-Assistant-Blueprints | Figma-Plugins, Browser-Erweiterungen | Obsidian, VS-Code-Extensions |

## 4. Sicherheit: der wichtigste Punkt

Die App hält **SSH-Passwörter, private Keys und offene Verbindungen** zu Servern. Ein
Plugin nach Weg C läuft im selben Prozess und könnte:

- alle gespeicherten Passwörter entschlüsseln und verschicken,
- die privaten Keys aus `~/.ssh` lesen,
- über offene Verbindungen beliebige Befehle auf den Servern ausführen.

VS Code und Obsidian leben mit diesem Risiko, weil ihre Nutzer den Plugin-Autoren
vertrauen. Bei einem SSH-Client ist der mögliche Schaden aber viel größer: **Ein einziges
bösartiges Plugin hat Zugang zu allen Servern des Nutzers.** Deshalb kommt Weg C hier
nicht in Frage.

## 5. Was man für ein Code-Plugin-System (Weg B) bräuchte

Damit klar ist, wie viel dahintersteckt:

1. **Manifest pro Plugin:** Name, Version, benötigte Rechte, genutzte Andockstellen.
2. **Loader:** findet Plugins in einem Ordner und lädt sie. Ein abstürzendes Plugin darf die App nicht mitreißen.
3. **Plugin-API:** Das ist der eigentliche Kern und der größte Aufwand. Jede angebotene Funktion (z. B. „Befehl auf Host ausführen“, „Panel anzeigen“) muss danach **stabil bleiben**; eine Änderung macht fremde Plugins kaputt.
4. **Sandkasten:** Das Plugin läuft in einem eigenen Prozess (Electron `utilityProcess`) oder einem isolierten `iframe`, ohne Node- und Dateisystemzugriff, und spricht nur per Nachrichten mit der App.
5. **Rechte-Abfrage:** „Plugin X möchte Befehle auf deinen Servern ausführen – erlauben?“, einmal pro Recht, jederzeit widerrufbar.
6. **Oberfläche:** Plugins installieren, an- und ausschalten, Fehler anzeigen.
7. **Dokumentation und TypeScript-Typen** für Plugin-Autoren, dazu eine Versionsnummer für die API.
8. **Verteilung:** Wo findet man Plugins, wie kommen Updates (z. B. ein Verzeichnis auf GitHub)?

## 6. Einschätzung: Ist das eine gute Idee?

- **Weg C (voller Zugriff):** **Nein**, wegen der Zugangsdaten (Abschnitt 4).
- **Weg B (Sandkasten):** Lohnt sich erst, **wenn andere Leute Plugins schreiben
  wollen**. Solange du das Tool vor allem selbst nutzt, ist es viel Aufwand mit
  dauerhafter Pflicht (stabile API, Doku). Features wie die AI-Integration sind direkt in
  der App schneller gebaut.
- **Weg A (deklarativ):** **Ja, als Einstieg.** Er ist sicher und klein, baut auf dem
  Vorhandenen auf und bringt alle Grundbausteine mit (Manifest, Loader, Andockstellen,
  Verwaltung), an die Weg B später andocken kann.

## 7. Vorschlag: Phase 1 mit Weg A

### Wo Plugins liegen

Jedes Plugin ist ein Ordner mit einer `plugin.json` im Config-Ordner der App:

```
%APPDATA%\better-ssh-client\plugins\mysql\plugin.json          (Windows)
~/.config/better-ssh-client/plugins/mysql/plugin.json          (Linux)
~/Library/Application Support/better-ssh-client/plugins/…      (macOS)
```

### Beispiel: ein MySQL-Plugin

```json
{
  "id": "mysql",
  "name": "MySQL",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Erkennt MySQL/MariaDB und bringt ein paar nützliche Befehle mit.",
  "contributes": {
    "services": [
      {
        "id": "mysql",
        "label": "MySQL",
        "detect": { "process": ["mysqld", "mariadbd"], "port": [3306] }
      }
    ],
    "snippets": [
      { "name": "MySQL status", "command": "systemctl status mysql --no-pager" },
      { "name": "MySQL slow log", "command": "sudo tail -n 100 /var/log/mysql/mysql-slow.log" }
    ]
  }
}
```

### Die ersten zwei Andockstellen

1. **Dienst-Erkennung (`services`):** Ein Plugin beschreibt, woran man einen Dienst
   erkennt: Prozessname, lauschender Port oder systemd-Unit. Die App prüft das mit der
   Probe-Ausgabe, die sie ohnehin schon holt, also ohne zusätzliche SSH-Befehle. Treffer
   bekommen ein Badge auf der Dashboard-Karte.
2. **Snippet-Pakete (`snippets`):** Ein Plugin bringt fertige Befehle mit. Sie erscheinen
   in der Snippet-Liste, als „von Plugin X“ markiert.

### Verwaltung

In den Settings eine Liste der gefundenen Plugins: Name, Version, was es beisteuert,
An/Aus-Schalter und bei Fehlern (kaputtes JSON, unbekannte `apiVersion`) eine verständliche
Meldung statt eines Absturzes.

### Warum das sicher ist

- Ein Plugin kann **nichts ausführen, was nicht lesbar als Befehl in seiner Datei steht**,
  und Snippets laufen nur, wenn du sie selbst startest.
- Die Dienst-Erkennung vergleicht nur Text mit der Probe-Ausgabe, sie führt nichts aus.
- Kein Plugin sieht Passwörter, Keys oder Verbindungen.

### Bausteine im Code (grob)

| Baustein | Wo |
|---|---|
| Manifest-Typen + Validierung (`apiVersion`, Pflichtfelder) | `packages/electron/src/core/plugins/manifest.ts` |
| Loader: Ordner einlesen, Fehler pro Plugin sammeln | `packages/electron/src/core/plugins/loader.ts` |
| Dienst-Registry: eingebaute + Plugin-Dienste | `core/ssh/services/registry.ts` erweitern |
| Snippets: eingebaute + Plugin-Snippets | Snippet-Liste um eine Quelle erweitern |
| IPC + Settings-Oberfläche | `ipc/plugins.ts`, `Settings.svelte` |
| Tests | Manifest-Validierung, Erkennung, Loader mit kaputten Plugins |

## 8. Mögliche spätere Phasen

- **Phase 2 (noch Weg A):** weitere Andockstellen, z. B. eigene Dashboard-Werte (ein
  Befehl, dessen Ausgabe als Wert auf der Karte erscheint) oder Kontextmenü-Aktionen im
  SFTP-Browser.
- **Phase 3 (Weg B), nur bei Bedarf:** Code-Plugins im Sandkasten mit Rechte-Abfrage.
  Das Manifest aus Phase 1 bekäme dafür ein Feld `"main": "plugin.js"` und `"permissions"`.

## 9. Offene Fragen

- Gibt es einen konkreten Anwendungsfall, der zuerst kommen soll? Davon hängt ab, welche Andockstellen Phase 1 bekommt.
- Sollen Plugins nur manuell in den Ordner kopiert werden, oder braucht es einen „Plugin installieren“-Knopf (z. B. aus einer ZIP-Datei)?
- Sollen die eingebauten fünf Dienste langfristig selbst als Plugins ausgeliefert werden? Das wäre sauber, ist aber für Phase 1 nicht nötig.

## 10. Prototyp: Code-Plugins im Sandkasten (Weg B)

Gebaut, um auszuprobieren, wie sich Weg B anfühlt. In den Settings als **experimental**
markiert.

### Wie es funktioniert

```
 plugins/<id>/plugin.json  ──►  Loader prüft Manifest  ──►  Settings: Liste + Schalter
                                                                     │ einschalten = Zustimmung
                                                                     ▼
                     unsichtbares Fenster pro Plugin (Sandkasten)
                     ┌───────────────────────────────────────────┐
                     │ main.js des Plugins                        │
                     │   └─ sieht nur `bssh` ──── Nachricht ────┐ │
                     └──────────────────────────────────────────┼─┘
                                                                ▼
                     Hauptprozess: Recht erteilt? ──► ja: ausführen / nein: Fehler
```

- **Sandkasten:** Jedes eingeschaltete Plugin läuft in einem eigenen, unsichtbaren
  Electron-Fenster: Chromium-Sandbox, kein Node.js, eigener Speicherbereich (keine
  gemeinsamen Cookies oder Speicher mit der App oder anderen Plugins).
- **Netzwerk:** Jede Anfrage wird abgebrochen, außer HTTPS zu einem Hostnamen, den das
  Plugin angemeldet hat (`network:<hostname>`). Zusätzlich verbietet eine
  Content-Security-Policy `eval` und nachgeladene Skripte.
- **Kein Ausbruch:** Navigation, neue Fenster und alle Browser-Berechtigungen (Kamera,
  Mikrofon, Benachrichtigungen …) sind gesperrt.
- **Rechte:** Jeder `bssh`-Aufruf wird im Hauptprozess gegen die Rechte geprüft, die der
  Nutzer beim Einschalten erteilt hat. Verlangt ein Plugin nach einem Update neue Rechte,
  ist es wieder aus, bis man es erneut einschaltet.
- **Kaputte Plugins** (falsches JSON, unbekannte API-Version, fehlende Datei) erscheinen
  in den Settings mit ihrer Fehlermeldung und stören den Rest nicht.

### Ein Plugin schreiben

Ein Ordner im Plugin-Verzeichnis (Settings → Plugins → *Open folder*), Ordnername = `id`:

```
plugins/
  docker-containers/
    plugin.json
    main.js
```

**`plugin.json`:**

```json
{
  "id": "docker-containers",
  "name": "Docker containers",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "description": "Lists the Docker containers on a host, from the command palette.",
  "permissions": ["hosts:exec"]
}
```

**`main.js`** läuft einmal beim Start des Plugins; `await` auf oberster Ebene ist erlaubt.
Ein vollständiges Beispiel liegt in `examples/plugins/docker-containers/`.

### Rechte

| Recht | Erlaubt |
|---|---|
| `hosts:read` | Host-Liste lesen: Name, Adresse, Benutzer, Port, Tags. **Nie** Passwörter oder Keys. |
| `hosts:exec` | Befehle auf den Hosts ausführen. Sehr mächtig: damit kann ein Plugin *alles* auf deinen Servern tun. |
| `network:<hostname>` | HTTPS-Anfragen an genau diesen Hostnamen, z. B. `network:api.github.com` |

Befehle registrieren und Text anzeigen brauchen kein Recht: Sie tun erst etwas, wenn du
den Befehl selbst auswählst.

### Die Schnittstelle `bssh` (API-Version 1)

| Funktion | Was sie tut | Recht |
|---|---|---|
| `bssh.commands.register(id, title, { needsHost }, handler)` | Befehl in der Befehlspalette (Ctrl+K). Mit `needsHost: true` wählt der Nutzer vorher einen Host; der Handler bekommt `{ host }`. | – |
| `bssh.hosts.list()` | Liste der Hosts (ohne Geheimnisse) | `hosts:read` |
| `bssh.hosts.exec(host, command)` | Befehl ausführen; Ergebnis `{ output, ok, error? }` (stdout+stderr, 60 s Timeout) | `hosts:exec` |
| `bssh.ui.showText(title, text)` | Text in einem Dialog anzeigen, immer mit dem Plugin-Namen beschriftet | – |
| `bssh.log(...)` | Ausgabe ins Log der App (Terminal, aus dem die App gestartet wurde) | – |
| `fetch(url)` | Normales Browser-`fetch`, nur zu erlaubten Hosts | `network:…` |

### Was geprüft ist

Mit einem Test-Plugin, das absichtlich auszubrechen versucht, in der echten App gegen
einen echten SSH-Server:

| Versuch | Ergebnis |
|---|---|
| `require`, `process` (Node.js) | nicht vorhanden |
| `eval`, `new Function` | blockiert (CSP) |
| `fetch` zu nicht angemeldeten Hosts | blockiert |
| `fetch` zu angemeldetem Host (`api.github.com`) | erlaubt (200) |
| lokale Datei per `file://` lesen | blockiert |
| `hosts.list` ohne `hosts:read` | abgelehnt |
| `window.open`, Seite wechseln | verhindert |
| `hosts.exec` mit `hosts:exec` | funktioniert |

Dazu Unit-Tests für Manifest-Prüfung, Rechte, Netzwerk-Regeln und den Loader.

### Grenzen des Prototyps

- **Keine eigene Oberfläche:** Plugins können nur Befehle anbieten und Text anzeigen.
  Eigene Panels (z. B. eine Container-Liste mit Knöpfen) wären der nächste große Schritt.
- **`hosts:exec` ist alles oder nichts:** Feiner wäre „nur diese Befehle“ oder „nur diese Hosts“.
- **Kein Schutz gegen Endlosschleifen:** Ein Plugin, das seinen Prozess auslastet, bremst
  nur sich selbst (eigener Renderer-Prozess), wird aber nicht automatisch beendet.
- **Keine Installation per Klick, keine Updates, keine Signaturen:** Plugins werden von
  Hand in den Ordner kopiert.
- **API noch nicht stabil:** Version 1 ist ein Entwurf; sie kann sich ändern, solange das
  Feature „experimental“ ist.

## Begriffe

- **Andockstelle** (engl. *extension point*): eine Stelle, an der Plugins etwas beisteuern dürfen.
- **Manifest:** die Beschreibungsdatei eines Plugins (`plugin.json`).
- **Sandkasten** (engl. *sandbox*): eine abgeschottete Umgebung, in der Code nur das darf, was ihm ausdrücklich erlaubt wurde.
- **Deklarativ:** Man *beschreibt*, was passieren soll (Daten), statt es zu *programmieren* (Code).
