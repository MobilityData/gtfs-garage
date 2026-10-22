# Validator rules

`rules.json` is published by gtfs-validator with every release and describes
every notice it can emit: its code, severity, summary, description, the files
and spec sections the rule reads, and the name, type and description of each
field in a sample.

It is vendored here, unedited, because the Quality guides are written against
it. `scripts/build_guides.py` merges it into `src/gtfs_garage/data/guides.json`
and refuses a guide that names a field its notice does not have.

| | |
|---|---|
| Validator version | 8.0.1 |
| Source | https://github.com/MobilityData/gtfs-validator/releases/download/v8.0.1/rules.json |

To move to a newer validator, replace the file with that release's
`rules.json`, update the version above and in `VERSION`, and run
`scripts/build-guides.sh`. A guide whose notice lost a field fails the build,
which is the point.
