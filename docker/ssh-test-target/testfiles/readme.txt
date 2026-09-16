This folder exists to give the SFTP browser and its Monaco editor something
real to open — a spread of file types (fileEdit.ts now recognises most of
what Monaco itself supports), a couple of files that should NOT open as
editable (photo.png, archive.zip — random bytes, not real images/archives),
one oversized file (huge.log, over the 2 MiB cap) to see the read-only
preview fallback, a nested folder to click through, and two filenames chosen
to exercise path quoting: one with a space, one with a single quote (the
one character shellQuote() has to escape for the terminal's autocd).
