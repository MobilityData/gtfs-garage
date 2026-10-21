# Quality

Load a gtfs-validator report beside the open feed and read what it found. The
**Quality** screen lists the findings, one per notice code, most severe first.
**Explain** starts the **Quality assistant**, a tour through one sample of a
notice: it opens the rows the notice is about, draws or plays what it means on
the map, and says why the validator raised it and what would fix it. Nothing is
changed for you.

Each step is a card floating beside what it points at, with an arrow at it. The
rest of the viewer is dimmed, with holes over the rows and the map the step is
using, so both stay visible when they move together; the dim takes no clicks,
so the table still scrolls and the map still pans. The arrow keys step through
and Escape leaves. Following a link out of a step docks the card in a corner,
offering the way back.

The walkthroughs are data in this repository, not code. Each notice code can
have a **guide**, a short YAML file written in a fixed vocabulary of actions,
and a code without one still gets a walkthrough derived from the fields of its
samples.

## Editing tours

Tours are written in the **Tour Studio**, the viewer at `/studio`, opened in a
tab of its own from **Options → Open Tour Studio**, or from **Edit tour** (or
**Create tour**) beside a notice in **Tours** (**Options → Open Tours**) or a
finding on the Quality screen. Your viewer tab keeps its feed: the studio
tries tours on demo feeds the server serves beside it, and saves to the same
workdir, so what the studio saves is what **Explain** plays in every tab,
without reloading.

The studio opens on **Tours**: every notice gtfs-validator can report, from
its rules rather than from a report, with where each one's tour comes from
(built in, saved, or automatic) and which demo feeds raise it. Search by code,
words or file; narrow by severity, by whether a tour is written, and to
notices a demo feed raises. Choosing one opens the editor, a column beside the
table and the map, so both stay in view while the tour runs.

- **Try it on** is where the sample comes from: each demo feed that raises the
  notice, with how many samples it has; your feed's report, when the studio
  was opened from a finding (the viewer tab hands it over); or **A sample I
  write**, a value per field of the notice, for a notice nothing at hand
  raises. Every sentence is shown under its field as the sample fills it, and
  each step says what it would lose on it: a step left out because the sample
  lacks a field, an action left out, rows that cannot be found.
- **Run tour**, or the play button on a step, plays the version being edited
  through the assistant, saved or not, on the feed the sample comes from. A
  sample written by hand has no rows behind it, so it previews and checks but
  does not run.
- **Form** is the default. A step is a sentence and the actions that
  illustrate it. An action that opens or shows rows says, inside it, which
  file and how to find them: by the validator's line, by column values, or,
  with neither, the whole file. Two actions can open the same rows, and the
  form says when they do. **+ field** inserts a field of the notice, with the
  sample's value beside it, and the formatted forms (`|m`, `|km`, `|kmh`,
  `|date`) where they fit; columns are offered from the file the rows are in,
  and a new action starts with the fields that obviously fit it.
- **YAML** is the file itself, for whoever would rather write it. The rows
  are the file's `locators`, named and shared. Comments are kept while you stay
  in it, and saved with it; going back to the form writes the file again
  without them. **Copy** and **Download** give the file to put in
  `schema/guides/`.
- **Create tour** starts from the automatic tour, the walkthrough readers see
  today, or from one empty step.
- **Save** is offered once the tour passes the same check as the build (see
  below); until then the problems are listed beside the fields they are about.
  The server checks it again, and refuses it with the reason if it fails.

Saved tours are kept in the workdir, as `<workdir>/guides/<code>.yaml`
(`/api/quality/guides`, see `docs/GtfsGarageAPI.yaml`), and win over the
built-in one for their notice; **Use built-in tour** or **Delete saved tour**
forgets one. Tours saved in the browser before the workdir kept them are moved
there the next time the viewer opens. A viewer with no server behind it keeps
them in the browser.

### Locked to the tour

While a tour is being played, and always in the studio, the viewer is locked
to it. The header becomes a bar saying what is open, with one way out (**Back
to Tours**, **Back to the finding**, **Close studio**); the Explore/Files
switch, Load feed, Options, the toolbar and the filter bar are put away, and a
link in a table cell or a click on the map no longer navigates. The sidebar
stays, as the feed's files, read-only, with the one a step opened lit. The map
draws the feed's network faintly, so only what a step draws, or focuses on,
stands out; a dense line of the network no longer reads as something picked out. The table still scrolls, the
map still pans and zooms, and the tour card steps. A tour run from the editor
ends back in the editor, Escape included; a tour played from Explain ends where
it was started. See `web/src/quality/session.ts`.

### Demo feeds

A demo is a feed and the report gtfs-validator wrote for it. The built-in ones
are the feeds in `src/gtfs_garage/data/demos/`, made to raise 171 of the 181
notices between them (see its README). **Add one of your own** at the bottom
of Tours: a feed already in the workdir and its `report.json`, kept under
`<workdir>/demos/`.

The server answers the same reading API for each demo beside its own feed, at
`/demos/<id>/api/...` (see `src/gtfs_garage/server/demo_feeds.py`), so the
studio reads a demo without the server swapping the feed your viewer tab
shows. A built-in demo is opened into a workdir slot of kind `demo`, which the
workdir's retention neither counts nor evicts; a feed one of your demos is made
of is never evicted, and neither can be deleted while the studio reads it.

The editor is `web/src/quality/editor/`, the Tours view
`web/src/ui/screens/tours.ts`, saved tours `web/src/quality/guide-store.ts` and
`src/gtfs_garage/core/saved_guides.py`, the studio's switching between feeds
`web/src/quality/studio-source.ts`, and the demos `src/gtfs_garage/core/demos.py`.

## Words used

| Word | Means |
|---|---|
| Quality | The screen: a loaded report read against the open feed. |
| Quality assistant | The process that walks through one finding, in the table and on the map. |
| finding | One notice code in the report, with its total and its samples. |
| walkthrough | One run of the assistant over one sample. |
| step | One sentence, the actions that illustrate it, and what its card points at. |
| action | One thing a step does: open rows, draw on the map, show a record. |
| guide | The file that describes the steps for one notice code. |
| tour | A guide as readers and analysts meet it: what Explain plays and Edit tour changes. |

## Where things are

| Path | What it is |
|---|---|
| `schema/validator/rules.json` | What gtfs-validator publishes about every notice: severity, summary, description, the files it reads, the fields of its samples. Vendored unedited; the version is in `schema/validator/VERSION`. |
| `schema/guides/<code>.yaml` | One guide per notice code. |
| `src/gtfs_garage/core/guides.py` | What a guide may say: the actions, the type of each argument, and `check_guide`, which the build and the server apply. |
| `scripts/build-guides.sh` | Checks every guide against the rules and writes the catalog. |
| `src/gtfs_garage/data/guides.json` | The catalog the viewer reads: every notice, with its guide where there is one. Generated and committed; `tests/test_guides.py` fails if it drifts. |
| `tests/data/guides/cases.json` | Guides and the problem each must be refused for, run by both the Python and the viewer's checks. |
| `web/src/quality/` | The report, the locators, the fallback, the walkthrough resolver, the actions, the assistant and its tour card (`tour.ts`). |
| `web/src/ui/screens/quality.ts` | The Quality screen. |
| `src/gtfs_garage/data/demos/` | The demo feeds: feeds that trigger 171 of the 181 notice codes between them, with the validator's report for each. Tours are tried on them, and the tests read them. See its README. |

## Writing a guide

```yaml
code: stop_too_far_from_shape

locators:
  stop:      { file: stops,      key: { stop_id: "{{stopId}}" } }
  stop_time: { file: stop_times, line: "{{stopTimeCsvRowNumber}}", key: { trip_id: "{{tripId}}", stop_id: "{{stopId}}" } }

steps:
  - text: "{{stopName}} is {{geoDistanceToShape|m}} from the nearest point of shape {{shapeId}}."
    point: map                     # the card points at the map; by default, at the rows
    actions:                       # run together: the table and the map move at once
      - { kind: open_rows,   at: stop, highlight: [stop_lat, stop_lon] }
      - { kind: map_focus,   shapes: ["{{shapeId}}"], stops: ["{{stopId}}"] }
      - { kind: map_measure, from: { stop: "{{stopId}}" }, to: { point: "{{match}}" }, threshold: 100 }

  - text: "The call that puts the stop on trip {{tripId}}."
    actions:
      - { kind: open_rows,    at: stop_time, highlight: [stop_sequence] }
      - { kind: map_sequence, trip: "{{tripId}}", mark: ["{{stopId}}"] }

fix:
  - "If the stop is in the wrong place, correct stop_lat and stop_lon for {{stopId}}."
```

**Templates.** `{{field}}` is a field of the notice's sample, exactly as the
validator names it in `rules.json`. A formatter may follow: `|m` and `|km` for
distances (`|m` keeps a decimal under ten metres), `|kmh` for speeds, `|date`
for a date, `|round` for a number whose unit the feed chooses (a distance
along a shape), `|coord` for a latitude or longitude, `|yesno` for true and
false, `|words` for a name the validator spells in capitals (MUST_PHONE as
"must phone"), `|from1` for a position the validator counts from 0, `|min` for
seconds as minutes, `|days` for a number of days with the right noun. There are
no expressions. Text between backticks is drawn as code in the card: use it for
file and column names.
A string that is exactly one placeholder passes the field's own value, so
`point: "{{match}}"` hands the action the coordinate pair rather than its text.

**Locators** name the rows a notice is about. `line` is the validator's
`csvRowNumber` (several may be given, comma-separated); `key` is a set of
column values. Give both where you can. The line is used when the table's line
numbers were checked against the file, the key when they were not. A locator
with only a `file` is the whole file.

**Steps** run their actions together. At most one action per step may change
the content pane (`open_rows`, `follow_link`, `timetable`, `calendar`); map
actions compose, so a focus, a measured distance and numbered calls can share
one step. A surface keeps what it shows until a later step changes it;
`clear: [map]` empties the map first. The rows work the same way: a step that
opens nothing of its own, the last one included, keeps the rows the step before
opened, lit and outlined, and its card points at them, so a tour can say
several things about one row without it fading behind the next card.
`clear: [rows]` lets them go. `point` says what the card points at,
`rows` or `map`; left out, it is the rows the step opens, else the map it draws
on, else nothing, and the card sits in the middle.

### Writing for readers

A tour is read by people who know transit but not GTFS: a planner, a data
manager at a small agency, someone presenting the findings. Write for them.

- **Say what is wrong first, in this sample's terms.** "Night Owl South is 556
  m from the line its trips are drawn with" before any file or column name.
- **Name a file or column only with what it is.** "`stop_times.txt`, the
  timetable: one row per stop each trip makes", "`route_color`, the colour apps
  draw the route in". After the first time in a tour, the name alone is enough.
- **Say why it matters to riders,** in one sentence: what an app shows wrong,
  what a rider misses, what a planner cannot trust.
- **Show, then tell.** A step's actions are what the reader looks at; its
  sentence says what to notice there. Do not describe what is plainly on
  screen.
- **One idea per step,** two to four steps before the fix. A system error or
  a notice about a whole file may need only one.
- **Fixes are things to do,** with the values: "Set `route_text_color` to
  FFFFFF so the white text stands out on 0055A4", not "fix the colour".
- **No jargon the validator uses and readers do not:** not "entity", "record",
  "CSV row number", "foreign key", "enum". Say "row", "line 12 of the file",
  "an id that points to", "one of the allowed values".
- **Use formatters for numbers:** `{{distance|m}}`, `{{speedKph|kmh}}`,
  `{{date|date}}`. A raw `555.9755058884797` is not for readers.
- **Write so a step still reads if an action is dropped:** a sample can lack
  a field, and the action using it is left out.

Every tour is tried on the demo feeds by `web/src/quality/tours.test.ts`: no
step may be left out on a demo sample, and every set of rows a step opens has
to be really there. `TOUR_PRINT=<file>` writes each tour as a reader reads it,
on every sample, for review.

**Sentences** say something about this sample. A step that only says where it
is going ("Where it is on the map") is better left to its card's arrow.

**Degrading.** An action whose placeholder the sample cannot fill is left out
and the panel says so; a list drops an item it cannot fill; a step whose
sentence cannot be filled is dropped. The validator has renamed fields between
releases, and a walkthrough should lose a step rather than break.

**The last step** is added for you. Its sentence is the first `fix` line, with
the rest below it; with no fix written, it is the first sentence of the rule in
the validator's words. The rest of the rule and its spec and best-practice
links fold underneath. When that sentence would only repeat a step before it,
there is no last step: the links go on the step before.

Run `scripts/build-guides.sh` after editing. It fails on a field the notice does
not have, an unknown formatter or action, an argument an action does not take or
a required one left out, an undeclared locator, two content actions in one step,
or a guide for a code the validator does not emit. The rules are
`check_guide` in `src/gtfs_garage/core/guides.py`; the viewer applies the same
ones (`web/src/quality/validate.ts`), and `tests/data/guides/cases.json` holds
the two to the same words.

## Actions

| Action | Arguments | Surface | What it does |
|---|---|---|---|
| `open_rows` | `at`, `mark`, `highlight`, `expect: empty` or `any`, `around` | content | Opens the file filtered to the rows, tints them and outlines the named columns. `expect: any` is for rows that may not exist: none is a fine answer, and nothing is said about it. `mark` names a second locator: all of `at` is shown and only those rows are tinted, so a trip's calls can be opened with the two in question picked out. `around: N` adds the lines either side, tinting only the named ones. `expect: empty` makes an empty result the finding. |
| `follow_link` | `from`, `to` | content | Opens `to` and says which join it followed. |
| `timetable` | `route`, `trip`, `date` | content | Opens the route's timetable with the trip's column selected; without a `route`, the trip's own, looked up in trips.txt. Without a `date`, on a day the trip runs: the one already chosen if it runs then, else the next, else its first. |
| `calendar` | `date` | content | Opens Service days. |
| `map_focus` | `routes`, `shapes`, `stops`, `points`, `locations` | map | Draws exactly those, and says when a shape has no line to draw. `locations` are zones of locations.geojson by id, drawn as filled areas; the second is in the warning colour. A list given as one string, "R10, RR1", is split on commas. |
| `map_measure` | `from`, `to`, `threshold` | map | A measured line between two stops or a stop and a point, in the warning colour over its threshold. |
| `map_sequence` | `trip`, `mark`, `speeds`, `limit` | map | The trip's calls numbered in order, with the marked stops picked out. `speeds: true` labels each leg with its speed; the leg between two marked stops, or over `limit` km/h, is in the warning colour. |
| `map_play` | `trip`, `from`, `to`, `around`, `mark`, `limit` | map | Plays the trip at its scheduled pace: a marker travels the legs from `from` to `to` and `around` calls either side (the whole trip without them), compressed to a few seconds and looping, with its clock and speed beside it. Each leg is labelled with its speed, the one at fault in the warning colour. As it reaches a call, the row of that call lights up in the open table. Calls with no time are timed by distance between the timed ones. Not played for a reader who asked for reduced motion. |
| `show_record` | `at`, `fields` | panel | One row as a card: each value with its type, whether it is required here, what empty means, and, for a column with a fixed list of codes, what each code means. |
| `compare_records` | `a`, `b`, `fields` | panel | Two rows side by side, equal values dimmed. |
| `show_model` | `files`, `edge` | panel | How the files connect, with the failing reference picked out. |
| `chart` | `at`, `x`, `y`, `mark` | panel | A line chart of two columns, with marked lines as points. |
| `show_files` | `missing`, `mark` | panel | The feed's files as chips: those it lacks dashed, those in question highlighted. For a missing, empty or unexpected file. |
| `show_columns` | `file`, `missing`, `mark` | panel | A file's header, its columns in order: those it lacks dashed, those in question highlighted (by name, or by position counted from 1, for a column with no name). For a missing, unknown, duplicated or empty column. |
| `show_value` | `value`, `label`, `expect` | panel | A value with what cannot be seen made visible: spaces at either end, line breaks, tabs, non-breaking spaces, control and non-ASCII characters, each named on hover. `expect` says what it should look like. |
| `show_colors` | `color`, `text`, `label` | panel | The colours as a rider's app draws a route label, the contrast between them, and whether that is readable; or that a value is not a colour. |
| `timeline` | `start`, `end`, `checked`, `start_label`, `end_label`, `count`, `other_start`, `other_end`, `other_label` | panel | A range of dates, or of times in a day, on a line, with the day the validator checked it: how long it lasts (`count`: `inclusive` days, the days `between`, or `none`), whether it had run out, how long it had left, or that it ends before it starts. With a second range, the two are drawn one above the other and their overlap shaded. |
| `custom` | `handler`, `args` | any | Calls a handler the host passed as `qualityActions`; the only action that is code. |

Speeds are counted the way gtfs-validator counts them: with both times on the
minute, one more minute is allowed for the seconds the feed rounded away. So
the 12 km from 06:00:00 to 06:01:00 in the main test feed is 360 km/h on the
map, as in the report, not 720.

A new action is a change to `web/src/quality/actions.ts` and to `ACTIONS` in
`src/gtfs_garage/core/guides.py`, which gives each argument a type and says
which are required; the build writes that into the catalog as `action_specs`. A new guide is neither. The map draws what the
actions produce through `MapHandle.annotate`, whose `motion` moves a marker
through timed positions; see `web/src/map/motion.ts`.

## Without a guide

A notice with no guide is explained from its sample's field names, which say a
great deal: a row number locates a row, and the file is the sample's
`filename` or the first file the rule reads; `fieldName` names the column; a
`stopId`, `fromStopId` or `stopId2` is a point on the map, two of them a
distance; a route or shape id is a line; `latFieldValue` and `lonFieldValue`
are a place; paired row numbers are two rows to compare. The map goes in the
same step as the rows. Every finding the main test feed raises is placed this
way or by a guide (`web/src/quality/quality.test.ts`).

## Line numbers

The validator locates most findings by `csvRowNumber`: the line of the file on
which the record **ends**, with the header as line 1. That was checked against
gtfs-validator 8.0.1, not assumed. The viewer answers the same number for every
row, and a filter on the reserved column `_line` selects rows by it.

For an ordinary file the number is the row's position in the converted Parquet
plus two, which costs nothing: DuckDB keeps a CSV's record order through its
parallel reader and through the conversion. A quoted value with a newline in
it, a row with the wrong number of fields (which the loader drops) or a blank
line breaks that arithmetic, so each file's physical line count is compared
with the rows kept. When they differ, the file is read once more with Python's
CSV reader, keeping exactly the records DuckDB kept, and the line of each is
stored as a column. `TableInfo.lines` says whether a table's numbers are
`exact` or `approximate`; see `src/gtfs_garage/core/lines.py`.
`tests/test_lines.py` asserts that every row number in the test reports selects
exactly the row the validator meant.

## Reports

The screen reads the `report.json` gtfs-validator writes, which its web service
and API return unchanged. Samples stored as a JSON string, as the Mobility
Database keeps them, are accepted too. The report stays in the browser, kept for
the session under the feed's name so a reload or a link to a step does not ask
for it again. A host that already has the report passes it as `report` to
`mount`. The screen says when the report's files or counts do not match the
open feed, because a report belongs to one version of a dataset.
