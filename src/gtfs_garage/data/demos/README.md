# Demo feeds

These feeds are both the built-in **demo feeds** that Quality tours are tried
on (listed in `demos.json`, served by `/api/quality/demos`; see
`docs/QUALITY.md`) and the test fixtures for the Quality assistant. They ship
in the package for the first reason and are read by the tests for the second.

GTFS feeds built to make [gtfs-validator](https://github.com/MobilityData/gtfs-validator)
8.0.1 emit as many of its notices as it can. Between them they trigger
172 of the 181 notice codes the validator publishes in `rules.json`; the
other 9 are deprecated, system errors, or need a file of a
billion rows.

Every agency, URL and address is invented: names are fictional, web addresses
and emails use `example.org`, and coordinates are around a made-up network in
Montreal.

## The feeds

| Feed | What it is for |
|---|---|
| `main` | One small network with as many problems as can coexist: route 10 along one street with a stop 400 m off its shape, a 12 km hop in one minute on route 20, shapes with every `shape_dist_traveled` mistake, a station with broken pathways, flexible trips over GeoJSON zones, Fares v2, booking rules, transfers and blocks. `attributions.txt` is where the row-level parse errors go (`missing_required_field`, `new_line_in_value` on a quoted value spanning two lines in the middle of the file, `invalid_row_length`, `invalid_url`, `invalid_email`, `invalid_integer`, `invalid_character`, `empty_row`), because a file with any of those is dropped whole and nothing depends on that one. |
| `future` | Service and feed dates that start after the validation date, a feed ending within 30 days, and `translations.txt` problems. The translations check runs only when every table loads, so it cannot share a feed with `main`'s parse errors. |
| `no-calendar` | No `calendar.txt`, `calendar_dates.txt` or `agency.txt`; two `feed_info.txt` rows each with one date; a `locations.geojson` that is not JSON. |
| `parse-errors` | One unreadable value kind per file, broken headers, an empty file, a value longer than the CSV reader accepts, no `feed_info.txt`, and a GeoJSON feature without properties beside a self-intersecting polygon. |
| `crash` | A calendar that ends before it starts, which stops two validators with an exception (reported in `crash.system_errors.json`), and a `locations.geojson` whose root is a Feature instead of a FeatureCollection. |
| `subfolder` | The files of a valid feed inside a `gtfs/` folder in the zip. |

Each feed's validator output is committed beside it as `<feed>.report.json`,
and `crash.system_errors.json` for the system error. The run is pinned so the
reports do not drift: validation date **2026-10-15**, country code **CA**.
Volatile summary fields (`validatedAt`, `validationTimeSeconds`,
`outputDirectory`, `gtfsInput`, `memoryUsageRecords`) are replaced with fixed
values and Java stack traces are dropped, so a refreshed report differs from
the committed one only where the notices do.

To refresh after editing a feed:

```bash
scripts/validate-quality-feeds.sh          # every feed
scripts/validate-quality-feeds.sh main     # one feed
```

## How the validator counts rows

`csvRowNumber` is the physical line on which a record ends, with the header as
line 1. In `main/attributions.txt` the record `A8` spans lines 9 and 10 because
its organization name holds a line break, and the validator reports it as row
10; the records after it keep their own physical line numbers (the short row is
reported as 13, the spaces-only last line as 16). For a file without line
breaks inside quoted values this is simply the record's position plus one.

Two smaller things worth knowing when reading the reports:

- `decreasing_shape_distance` names the earlier point as `csvRowNumber` and the
  later, smaller one as `prevCsvRowNumber`, the reverse of what the names
  suggest.
- Any row-level ERROR (an unreadable value, a missing required value, a wrong
  column count) makes the validator discard the whole file, and every check
  that reads that file is skipped. That is why the parse errors are spread over
  files nothing else depends on, and why some codes need their own feed.

## Coverage

| Code | Severity | Triggered by |
|---|---|---|
| `attribution_without_role` | WARNING | `main` |
| `bidirectional_exit_gate` | ERROR | `main` |
| `big_gap_in_service` | INFO | `main` |
| `block_trips_with_overlapping_stop_times` | ERROR | `main` |
| `csv_parsing_failed` | ERROR | `parse-errors` |
| `decreasing_or_equal_stop_time_distance` | ERROR | `main` |
| `decreasing_shape_distance` | ERROR | `main` |
| `duplicate_fare_media` | WARNING | `main` |
| `duplicate_geo_json_key` | ERROR | `main` |
| `duplicate_geography_id` | ERROR | `main` |
| `duplicate_key` | ERROR | `main` |
| `duplicate_route_name` | WARNING | `main` |
| `duplicated_column` | ERROR | `parse-errors` |
| `empty_column_name` | ERROR | `parse-errors` |
| `empty_file` | ERROR | `parse-errors` |
| `empty_row` | WARNING | `main` |
| `equal_shape_distance_diff_coordinates` | ERROR | `main` |
| `equal_shape_distance_diff_coordinates_distance_below_threshold` | WARNING | `main` |
| `equal_shape_distance_same_coordinates` | WARNING | `main` |
| `expired_calendar` | WARNING | `main` |
| `fare_product_with_multiple_default_rider_categories` | ERROR | `main` |
| `fare_transfer_rule_duration_limit_type_without_duration_limit` | ERROR | `main` |
| `fare_transfer_rule_duration_limit_without_type` | ERROR | `main` |
| `fare_transfer_rule_invalid_transfer_count` | ERROR | `main` |
| `fare_transfer_rule_missing_transfer_count` | ERROR | Not triggered. Deprecated: replaced by `fare_transfer_rule_without_transfer_count`; nothing emits it. |
| `fare_transfer_rule_with_forbidden_transfer_count` | ERROR | `main` |
| `fare_transfer_rule_without_transfer_count` | ERROR | `main` |
| `fast_travel_between_consecutive_stops` | WARNING | `main` |
| `fast_travel_between_far_stops` | WARNING | `main` |
| `feed_expiration_date30_days` | WARNING | `future` |
| `feed_expiration_date7_days` | WARNING | `main` |
| `feed_info_lang_and_agency_lang_mismatch` | WARNING | `main` |
| `feed_valid_beyond_total_service_window` | INFO | `main` |
| `forbidden_arrival_or_departure_time` | ERROR | `main` |
| `forbidden_continuous_pickup_drop_off` | ERROR | `main` |
| `forbidden_drop_off_type` | ERROR | `main` |
| `forbidden_geography_id` | ERROR | `main` |
| `forbidden_pickup_type` | ERROR | `main` |
| `forbidden_prior_day_booking_field_value` | ERROR | `main` |
| `forbidden_prior_notice_start_day` | ERROR | `main` |
| `forbidden_prior_notice_start_time` | ERROR | `main` |
| `forbidden_real_time_booking_field_value` | ERROR | `main` |
| `forbidden_same_day_booking_field_value` | ERROR | `main` |
| `forbidden_shape_dist_traveled` | ERROR | `main` |
| `foreign_key_violation` | ERROR | `main`, `no-calendar` |
| `future_calendar` | INFO | `future` |
| `future_feed` | INFO | `future` |
| `geo_json_duplicated_element` | ERROR | `future` |
| `geo_json_unknown_element` | INFO | `main`, `crash` |
| `i_o_error` | ERROR | Not triggered. System error: the archive cannot be read from disk. Not reproducible with feed content. |
| `inconsistent_agency_lang` | WARNING | `main` |
| `inconsistent_agency_timezone` | ERROR | `main` |
| `inconsistent_route_type_for_block_id` | WARNING | `main` |
| `inconsistent_route_type_for_in_seat_transfer` | WARNING | `main` |
| `invalid_character` | ERROR | `main` |
| `invalid_color` | ERROR | `parse-errors` |
| `invalid_currency` | ERROR | `parse-errors` |
| `invalid_currency_amount` | ERROR | `parse-errors` |
| `invalid_date` | ERROR | `parse-errors` |
| `invalid_email` | ERROR | `main` |
| `invalid_float` | ERROR | `parse-errors` |
| `invalid_geometry` | ERROR | `parse-errors` |
| `invalid_input_files_in_subfolder` | ERROR | `subfolder` |
| `invalid_integer` | ERROR | `main` |
| `invalid_language_code` | ERROR | `parse-errors` |
| `invalid_phone_number` | ERROR | `parse-errors` |
| `invalid_pickup_drop_off_window` | ERROR | `main` |
| `invalid_prior_notice_duration_min` | ERROR | `main` |
| `invalid_row_length` | ERROR | `main` |
| `invalid_time` | ERROR | `parse-errors` |
| `invalid_timezone` | ERROR | `parse-errors` |
| `invalid_url` | ERROR | `main` |
| `leading_or_trailing_whitespaces` | WARNING | `main` |
| `location_with_unexpected_stop_time` | ERROR | `main` |
| `location_without_parent_station` | ERROR | `main` |
| `malformed_json` | ERROR | `no-calendar` |
| `missing_bike_allowance` | WARNING | `main` |
| `missing_calendar_and_calendar_date_files` | ERROR | `no-calendar`, `subfolder` |
| `missing_feed_contact_email_and_url` | WARNING | `main` |
| `missing_feed_info_date` | WARNING | `no-calendar` |
| `missing_level_id` | ERROR | `main` |
| `missing_pickup_drop_off_booking_rule_id` | WARNING | `main` |
| `missing_pickup_or_drop_off_window` | ERROR | `main` |
| `missing_prior_day_booking_field_value` | ERROR | Not triggered. Deprecated: replaced by `missing_prior_notice_last_day` and `missing_prior_notice_last_time`; nothing emits it. |
| `missing_prior_notice_duration_min` | ERROR | `main` |
| `missing_prior_notice_last_day` | ERROR | `main` |
| `missing_prior_notice_last_time` | ERROR | `main` |
| `missing_prior_notice_start_time` | ERROR | `main` |
| `missing_recommended_column` | WARNING | Not triggered. Deprecated: nothing in 8.0.1 emits it. |
| `missing_recommended_field` | WARNING | `main`, `no-calendar` |
| `missing_recommended_file` | WARNING | `parse-errors`, `subfolder` |
| `missing_required_agency_id` | ERROR | `main` |
| `missing_required_column` | ERROR | `parse-errors` |
| `missing_required_element` | ERROR | `parse-errors` |
| `missing_required_field` | ERROR | `main` |
| `missing_required_file` | ERROR | `no-calendar`, `subfolder` |
| `missing_stop_name` | ERROR | `main` |
| `missing_stop_times_record` | ERROR | `main` |
| `missing_timepoint_value` | WARNING | `main` |
| `missing_trip_edge` | ERROR | `main` |
| `mixed_case_recommended_field` | WARNING | `main` |
| `more_than_one_entity` | WARNING | `no-calendar` |
| `new_line_in_value` | ERROR | `main` |
| `non_ascii_or_non_printable_char` | WARNING | `main` |
| `number_out_of_range` | ERROR | `parse-errors` |
| `overlapping_frequency` | ERROR | `main` |
| `overlapping_zone_and_pickup_drop_off_window` | ERROR | `main` |
| `pathway_dangling_generic_node` | WARNING | `main` |
| `pathway_loop` | WARNING | `main` |
| `pathway_to_platform_with_boarding_areas` | ERROR | `main` |
| `pathway_to_stop_with_access_outside_of_station_pathways` | ERROR | `main` |
| `pathway_to_wrong_location_type` | ERROR | `main` |
| `pathway_unreachable_location` | ERROR | `main` |
| `platform_without_parent_station` | INFO | `main` |
| `point_near_origin` | ERROR | `main` |
| `point_near_pole` | ERROR | `main` |
| `prior_notice_last_day_after_start_day` | ERROR | `main` |
| `route_both_short_and_long_name_missing` | ERROR | `main` |
| `route_color_contrast` | WARNING | `main` |
| `route_long_name_contains_short_name` | WARNING | `main` |
| `route_networks_specified_in_more_than_one_file` | ERROR | `main` |
| `route_short_name_too_long` | WARNING | `main` |
| `runtime_exception_in_loader_error` | ERROR | Not triggered. System error: a bug in a file loader. No known feed content triggers it. |
| `runtime_exception_in_validator_error` | ERROR | `crash` (system error) |
| `same_name_and_description_for_route` | WARNING | `main` |
| `same_name_and_description_for_stop` | WARNING | `main` |
| `same_route_and_agency_url` | WARNING | `main` |
| `same_stop_and_agency_url` | WARNING | `main` |
| `same_stop_and_route_url` | WARNING | `main` |
| `service_extends_far_in_the_future` | INFO | `main` |
| `service_has_no_active_day_of_the_week` | WARNING | `main` |
| `service_window_outside_feed_period` | INFO | `main` |
| `single_shape_point` | WARNING | `main` |
| `start_and_end_range_equal` | ERROR | `main` |
| `start_and_end_range_out_of_order` | ERROR | `main`, `crash` |
| `station_with_parent_station` | ERROR | `main` |
| `stop_access_specified_for_incorrect_location` | ERROR | `main` |
| `stop_access_specified_for_stop_with_no_parent_station` | ERROR | `main` |
| `stop_has_too_many_matches_for_shape` | WARNING | `main` |
| `stop_time_timepoint_without_times` | ERROR | `main` |
| `stop_time_with_arrival_before_previous_departure_time` | ERROR | `main` |
| `stop_time_with_only_arrival_or_departure_time` | ERROR | `main` |
| `stop_too_far_from_shape` | WARNING | `main` |
| `stop_too_far_from_shape_using_user_distance` | WARNING | `main` |
| `stop_without_location` | ERROR | `main` |
| `stop_without_stop_time` | WARNING | `main` |
| `stop_without_zone_id` | INFO | `main` |
| `stops_match_shape_out_of_order` | WARNING | `main` |
| `thread_execution_error` | ERROR | Not triggered. System error: a failure in the validator's thread pool. Not reproducible with feed content. |
| `timeframe_only_start_or_end_time_specified` | ERROR | `main` |
| `timeframe_overlap` | ERROR | `main` |
| `timeframe_start_or_end_time_greater_than_twenty_four_hours` | ERROR | `main` |
| `too_many_rows` | ERROR | Not triggered. Needs a file of more than 1,000,000,000 rows. |
| `transfer_distance_above_2_km` | INFO | `main` |
| `transfer_distance_too_large` | WARNING | `main` |
| `transfer_with_invalid_stop_location_type` | ERROR | `main` |
| `transfer_with_invalid_trip_and_route` | ERROR | `main` |
| `transfer_with_invalid_trip_and_stop` | ERROR | `main` |
| `transfer_with_suspicious_mid_trip_in_seat` | WARNING | `main` |
| `translation_foreign_key_violation` | ERROR | `future` |
| `translation_unexpected_value` | ERROR | `future` |
| `translation_unknown_table_name` | WARNING | `future` |
| `trip_coverage_not_active_for_next7_days` | WARNING | `main`, `future`, `crash` |
| `trip_distance_exceeds_shape_distance` | ERROR | `main` |
| `trip_distance_exceeds_shape_distance_below_threshold` | WARNING | `main` |
| `trip_headsign_matches_intermediate_stop` | INFO | `main` |
| `trip_with_shape_dist_traveled_but_no_shape_distances` | INFO | `main` |
| `u_r_i_syntax_error` | ERROR | Not triggered. System error: a malformed `--url` argument, not feed content. |
| `unexpected_enum_value` | WARNING | `main` |
| `unknown_column` | INFO | `main`, `parse-errors` |
| `unknown_file` | INFO | `main` |
| `unsorted_stop_times` | INFO | `main` |
| `unsupported_feature_type` | ERROR | `main` |
| `unsupported_geo_json_type` | ERROR | `crash` |
| `unsupported_geometry_type` | ERROR | `main` |
| `unusable_trip` | WARNING | `main` |
| `unused_parent_station` | INFO | Not triggered. Deprecated: replaced by `unused_station`; nothing emits it. |
| `unused_shape` | WARNING | `main` |
| `unused_station` | INFO | `main` |
| `unused_trip` | WARNING | `main` |
| `wrong_parent_location_type` | ERROR | `main` |

**172 of 181 codes triggered.** The 9 not triggered are four deprecated codes that
8.0.1 no longer emits, four system errors that depend on the machine or the
command line rather than on feed content, and `too_many_rows`.
