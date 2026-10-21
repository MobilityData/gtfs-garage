# Quality guides

One file per gtfs-validator notice code, describing how the Quality assistant
walks a reader through that notice. See `docs/QUALITY.md` for the format and
the action vocabulary, and `schema/validator/rules.json` for the fields each
notice's samples carry.

After editing, run `scripts/build-guides.sh`. It checks every guide against the
vendored rules and writes `src/gtfs_garage/data/guides.json`, which the viewer
reads. A code with no guide here still gets a walkthrough, derived from the
fields of its samples.
