// Live payloads for opa_get_well_activity (#121). Do not hand-edit: re-capture.

/** Verbatim live response, api.oilpriceapi.com/v1/ei/well-permits/summary?days=30, captured 2026-09-13 (enterprise smoke key). */
export const LIVE_WELL_PERMITS_SUMMARY_30D = {
  "status": "success",
  "data": {
    "period_days": 30,
    "total_permits": 1520,
    "by_state": {
      "PA": 73,
      "LA": 38,
      "ND": 57,
      "TX": 924,
      "OH": 30,
      "MI": 2,
      "MS": 38,
      "UT": 47,
      "NE": 1,
      "WV": 36,
      "CO": 155,
      "VA": 5,
      "OK": 59,
      "KS": 55
    },
    "top_operators": [
      {
        "name": "Coterra Energy",
        "count": 102
      },
      {
        "name": "Diamondback Energy",
        "count": 54
      },
      {
        "name": "Occidental Petroleum",
        "count": 53
      },
      {
        "name": "Pioneer Natural Resources",
        "count": 44
      },
      {
        "name": "EOG Resources",
        "count": 41
      },
      {
        "name": "Liberty Operating Company, LLC",
        "count": 32
      },
      {
        "name": "Bison IV Operating LLC",
        "count": 27
      },
      {
        "name": "Apache Corporation",
        "count": 23
      },
      {
        "name": "DE Central Operating, LLC",
        "count": 23
      },
      {
        "name": "Permian Resources",
        "count": 23
      }
    ],
    "top_formations": [
      {
        "name": "NIOBRARA",
        "count": 26
      },
      {
        "name": "UTICA",
        "count": 26
      },
      {
        "name": "MARCELLUS",
        "count": 2
      },
      {
        "name": "CHESTER",
        "count": 1
      },
      {
        "name": "CODELL",
        "count": 1
      },
      {
        "name": "MISSISSIPPIAN",
        "count": 1
      }
    ],
    "by_permit_type": {
      "reenter": 11,
      "recomplete": 64,
      "": 7,
      "new_drill": 1438
    },
    "weekly_trend": [
      {
        "week": "2026-08-10",
        "count": 105
      },
      {
        "week": "2026-08-17",
        "count": 478
      },
      {
        "week": "2026-08-24",
        "count": 306
      },
      {
        "week": "2026-08-31",
        "count": 373
      },
      {
        "week": "2026-09-07",
        "count": 258
      }
    ],
    "last_updated": "2026-09-13",
    "as_of": "2026-09-13",
    "data_age_days": 0,
    "stale": false,
    "as_of_basis": "max(permit_date) across all states in this response",
    "by_state_as_of": {
      "AK": {
        "as_of": "2026-07-26",
        "data_age_days": 49,
        "stale": false
      },
      "AL": {
        "as_of": "2026-07-19",
        "data_age_days": 56,
        "stale": false
      },
      "AR": {
        "as_of": "2026-08-01",
        "data_age_days": 43,
        "stale": false
      },
      "CA": {
        "as_of": "2026-07-30",
        "data_age_days": 45,
        "stale": false
      },
      "CO": {
        "as_of": "2026-09-13",
        "data_age_days": 0,
        "stale": false
      },
      "FL": {
        "as_of": "2020-03-04",
        "data_age_days": 2384,
        "stale": true
      },
      "IL": {
        "as_of": "2026-07-27",
        "data_age_days": 48,
        "stale": false
      },
      "KS": {
        "as_of": "2026-09-10",
        "data_age_days": 3,
        "stale": false
      },
      "KY": {
        "as_of": "2026-08-12",
        "data_age_days": 32,
        "stale": false
      },
      "LA": {
        "as_of": "2026-09-10",
        "data_age_days": 3,
        "stale": false
      },
      "MI": {
        "as_of": "2026-08-25",
        "data_age_days": 19,
        "stale": false
      },
      "MS": {
        "as_of": "2026-09-09",
        "data_age_days": 4,
        "stale": false
      },
      "MT": {
        "as_of": "2026-01-01",
        "data_age_days": 255,
        "stale": true
      },
      "ND": {
        "as_of": "2026-09-10",
        "data_age_days": 3,
        "stale": false
      },
      "NE": {
        "as_of": "2026-09-09",
        "data_age_days": 4,
        "stale": false
      },
      "NM": {
        "as_of": "2026-07-01",
        "data_age_days": 74,
        "stale": false
      },
      "NY": {
        "as_of": "2026-07-02",
        "data_age_days": 73,
        "stale": false
      },
      "OH": {
        "as_of": "2026-09-10",
        "data_age_days": 3,
        "stale": false
      },
      "OK": {
        "as_of": "2026-09-10",
        "data_age_days": 3,
        "stale": false
      },
      "PA": {
        "as_of": "2026-09-11",
        "data_age_days": 2,
        "stale": false
      },
      "TN": {
        "as_of": "2023-07-11",
        "data_age_days": 1160,
        "stale": true
      },
      "TX": {
        "as_of": "2026-09-11",
        "data_age_days": 2,
        "stale": false
      },
      "UT": {
        "as_of": "2026-09-03",
        "data_age_days": 10,
        "stale": false
      },
      "VA": {
        "as_of": "2026-08-19",
        "data_age_days": 25,
        "stale": false
      },
      "WV": {
        "as_of": "2026-09-03",
        "data_age_days": 10,
        "stale": false
      },
      "WY": {
        "as_of": "2025-03-25",
        "data_age_days": 537,
        "stale": true
      }
    },
    "stale_states": [
      "FL",
      "MT",
      "TN",
      "WY"
    ]
  }
} as const;

/** Verbatim live body of GET /v1/ei/well-permits/states: HTTP 500 after 25.07s, 2026-09-13. */
export const LIVE_WELL_PERMITS_STATES_500 = {
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "The API failed to process this request. Retry an idempotent request with bounded backoff, and quote request_id if you contact support.",
    "status": 500,
    "request_id": "a50d45a5-3635-4752-8d12-a00d44d59666",
    "docs": "https://docs.oilpriceapi.com#INTERNAL_SERVER_ERROR"
  }
} as const;

/** Verbatim live response, api.oilpriceapi.com/v1/ei/well-permits/states/TX, captured 2026-09-13 (enterprise smoke key). */
export const LIVE_WELL_PERMITS_STATE_TX = {
  "status": "success",
  "data": {
    "state": {
      "state_code": "TX",
      "source": "texas_rrc",
      "status": "available",
      "recommended_use": "Use for permit analysis with the source and freshness fields shown here.",
      "record_count": 420354,
      "dated_record_count": 420354,
      "missing_permit_date_count": 0,
      "permit_date_coverage_pct": 100.0,
      "earliest_permit_date": "1966-07-28",
      "latest_permit_date": "2026-09-11",
      "as_of": "2026-09-11",
      "as_of_basis": "max(permit_date)",
      "data_age_days": 2,
      "latest_fetched_at": "2026-09-12T23:03:45.882Z",
      "future_permit_date_count": 0,
      "source_record_count": 52289,
      "configured_date_coverage": "full",
      "note": "RRC API with spud dates; 100% of rows carry a permit_date (measured 2026-07-23)",
      "scraper_recovery": {
        "status": "unknown",
        "consecutive_failures": 0,
        "last_success_at": null,
        "last_failure_at": null
      },
      "truth_guard": {
        "ok": true,
        "window_days": 365,
        "window_permit_count": 7667,
        "rules": [],
        "violations": []
      },
      "report_health_status": "measured",
      "last_successful_report_date": "2026-09-12",
      "last_report_date": "2026-09-12",
      "last_report_status": "published",
      "failed_report_days": 0
    },
    "meta": {
      "as_of": "2026-09-11",
      "data_age_days": 2,
      "stale": false,
      "as_of_basis": "max(permit_date)"
    }
  }
} as const;
