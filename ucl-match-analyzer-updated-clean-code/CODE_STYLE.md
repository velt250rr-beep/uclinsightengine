# Code style and maintenance

This project keeps its source readable so errors are easy to locate and changes stay local.

## Formatting

- Use UTF-8 text and two spaces for indentation in HTML, CSS, and JavaScript.
- Prefer one JavaScript statement per line and keep semicolons consistent.
- Put one CSS declaration on each line, with a space after the colon.
- Keep JSON valid JSON; JSON files do not support comments.
- Use blank lines between logical sections and functions.

## Comments

- Where the format supports comments, start each source file with a short note describing its responsibility.
- Use HTML comments (`<!-- ... -->`) and CSS comments (`/* ... */`) to label larger sections.
- Use JavaScript comments (`// ...`) or JSDoc (`/** ... */`) to explain non-obvious logic, dependencies, and public behavior.
- Prefer comments that explain why a decision exists. Names should explain what a function or variable does.
- Avoid comments on every line; keep them close to the code they describe.

## File ownership

- `index.html` defines the page shell and script dependency order.
- `css/` contains the active stylesheets; `css/results.css` is the active results stylesheet.
- `js/` contains application logic; `js/ui/` contains page rendering and chart helpers.
- `data/` contains bundled match and team data; `proxy/worker.js` contains server-side API proxy behavior.
- `tests/` contains automated checks and shared test fixtures.
- `js/views.js`, `js/match-center.js`, and `js/teamlogos.js` are compatibility copies. Their active counterparts are in `js/ui/` and `data/`.
- `js/results.css` is a legacy stylesheet; `css/results.css` is the one loaded by the app.

## Search and imports

- Use the exact lowercase spelling of filenames in HTML `src`/`href` attributes and JavaScript `require()` calls. The production host is case-sensitive.
- Keep file paths and module responsibilities in comments and documentation aligned with the files on disk.
- Search by stable identifiers such as a function name, CSS class, data attribute, or route name.
