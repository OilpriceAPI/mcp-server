// Live payloads for the marine workflow tools (#125). Do not hand-edit: re-capture.
// Captured 2026-10-15 from api.oilpriceapi.com with the production smoke key.

/** Verbatim: GET /v1/marine-ports */
export const LIVE_MARINE_PORTS = {
  "status": "success",
  "data": {
    "ports": [
      {
        "code": "SGSIN",
        "name": "Singapore",
        "country": "Singapore",
        "region": "Asia",
        "major_port": true,
        "coordinates": {
          "latitude": 1.2966,
          "longitude": 103.7764
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380",
          "HFO_180"
        ],
        "trading_hours": "24/7"
      },
      {
        "code": "NLRTM",
        "name": "Rotterdam",
        "country": "Netherlands",
        "region": "Europe",
        "major_port": true,
        "coordinates": {
          "latitude": 51.9225,
          "longitude": 4.47917
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380",
          "HFO_180"
        ],
        "trading_hours": "24/7"
      },
      {
        "code": "USHOU",
        "name": "Houston",
        "country": "United States",
        "region": "Americas",
        "major_port": true,
        "coordinates": {
          "latitude": 29.7604,
          "longitude": -95.3698
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380",
          "HFO_180"
        ],
        "trading_hours": "24/7"
      },
      {
        "code": "AEFUJ",
        "name": "Fujairah",
        "country": "United Arab Emirates",
        "region": "Middle East",
        "major_port": true,
        "coordinates": {
          "latitude": 25.1312,
          "longitude": 56.3269
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380",
          "HFO_180"
        ],
        "trading_hours": "24/7"
      },
      {
        "code": "HKHKG",
        "name": "Hong Kong",
        "country": "Hong Kong",
        "region": "Asia",
        "major_port": true,
        "coordinates": {
          "latitude": 22.3193,
          "longitude": 114.1694
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380"
        ],
        "trading_hours": "24/7"
      },
      {
        "code": "USLAX",
        "name": "Los Angeles",
        "country": "United States",
        "region": "Americas",
        "major_port": true,
        "coordinates": {
          "latitude": 33.7405,
          "longitude": -118.2637
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380"
        ],
        "trading_hours": "06:00-22:00"
      },
      {
        "code": "BRSSZ",
        "name": "Santos",
        "country": "Brazil",
        "region": "Americas",
        "major_port": true,
        "coordinates": {
          "latitude": -23.9537,
          "longitude": -46.3227
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380"
        ],
        "trading_hours": "06:00-22:00"
      },
      {
        "code": "USNYC",
        "name": "New York",
        "country": "United States",
        "region": "Americas",
        "major_port": true,
        "coordinates": {
          "latitude": 40.7128,
          "longitude": -74.006
        },
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380"
        ],
        "trading_hours": "06:00-22:00"
      }
    ],
    "count": 8,
    "filters": {
      "region": null,
      "country": null,
      "major_ports_only": false
    }
  }
};

/** Verbatim: GET /v1/marine-ports/SGSIN */
export const LIVE_MARINE_PORT_SGSIN = {
  "status": "success",
  "data": {
    "port": {
      "code": "SGSIN",
      "name": "Singapore",
      "country": "Singapore",
      "region": "Asia",
      "major_port": true,
      "coordinates": {
        "latitude": 1.2966,
        "longitude": 103.7764
      },
      "metadata": {
        "timezone": "Asia/Singapore",
        "fuel_services": [
          "MGO_05S",
          "VLSFO",
          "HFO_380",
          "HFO_180"
        ],
        "trading_hours": "24/7",
        "annual_volume_mt": 50000000
      },
      "fuel_services": [
        "MGO_05S",
        "VLSFO",
        "HFO_380",
        "HFO_180"
      ],
      "trading_hours": "24/7",
      "timezone": "Asia/Singapore",
      "annual_volume_mt": 50000000,
      "recent_prices": [
        {
          "fuel_type": "HFO_380",
          "fuel_name": "Heavy Fuel Oil 380 CST (HFO 380) - Singapore (SGSIN)",
          "price": 876,
          "formatted": "$876.00",
          "currency": "USD",
          "unit": "metric_ton",
          "source": "market_reporting",
          "timestamp": "2026-10-15T03:11:13.045Z"
        },
        {
          "fuel_type": "MGO_05S",
          "fuel_name": "Marine Gas Oil 0.5%S (MGO) - Singapore (SGSIN)",
          "price": 1295,
          "formatted": "$1295.00",
          "currency": "USD",
          "unit": "metric_ton",
          "source": "market_reporting",
          "timestamp": "2026-10-15T03:11:12.984Z"
        },
        {
          "fuel_type": "VLSFO",
          "fuel_name": "Very Low Sulfur Fuel Oil (VLSFO) - Singapore (SGSIN)",
          "price": 917,
          "formatted": "$917.00",
          "currency": "USD",
          "unit": "metric_ton",
          "source": "market_reporting",
          "timestamp": "2026-10-15T03:11:12.927Z"
        }
      ],
      "statistics": {
        "total_fuel_types": 4,
        "recent_price_updates": 3,
        "last_update": "2026-10-15T03:11:13Z"
      }
    }
  }
};

/** Verbatim: GET /v1/prices/marine-fuels/historical?port_code=SGSIN&fuel_type=VLSFO_SGSIN_USD&days=7 */
export const LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D = {
  "status": "success",
  "data": {
    "prices": [
      {
        "port_code": "SGSIN",
        "port_name": "Singapore",
        "country": "Singapore",
        "region": "Asia",
        "coordinates": {
          "latitude": 1.2966,
          "longitude": 103.7764
        },
        "fuels": [
          {
            "code": "VLSFO_SGSIN_USD",
            "fuel_type": "VLSFO",
            "fuel_name": "Very Low Sulfur Fuel Oil (VLSFO) - Singapore (SGSIN)",
            "price": 917,
            "formatted": "$917.00",
            "currency": "USD",
            "unit": "metric_ton",
            "source": "market_reporting",
            "timestamp": "2026-10-15T03:11:12.927Z",
            "quality_grade": "ISO 8217 RMG380",
            "as_of": "2026-10-14T17:00:00.000Z",
            "collected_at": "2026-10-15T03:11:12.927Z",
            "synthetic": false,
            "stale": false,
            "age_days": 1
          },
          {
            "code": "VLSFO_SGSIN_USD",
            "fuel_type": "VLSFO",
            "fuel_name": "Very Low Sulfur Fuel Oil (VLSFO) - Singapore (SGSIN)",
            "price": 907,
            "formatted": "$907.00",
            "currency": "USD",
            "unit": "metric_ton",
            "source": "market_reporting",
            "timestamp": "2026-10-14T03:11:02.913Z",
            "quality_grade": "ISO 8217 RMG380",
            "as_of": "2026-10-13T17:00:00.000Z",
            "collected_at": "2026-10-14T03:11:02.913Z",
            "synthetic": false,
            "stale": true,
            "age_days": 2
          },
          {
            "code": "VLSFO_SGSIN_USD",
            "fuel_type": "VLSFO",
            "fuel_name": "Very Low Sulfur Fuel Oil (VLSFO) - Singapore (SGSIN)",
            "price": 892.5,
            "formatted": "$892.50",
            "currency": "USD",
            "unit": "metric_ton",
            "source": "market_reporting",
            "timestamp": "2026-10-13T03:11:13.189Z",
            "quality_grade": "ISO 8217 RMG380",
            "as_of": "2026-10-12T17:00:00.000Z",
            "collected_at": "2026-10-13T03:11:13.189Z",
            "synthetic": false,
            "stale": true,
            "age_days": 3
          },
          {
            "code": "VLSFO_SGSIN_USD",
            "fuel_type": "VLSFO",
            "fuel_name": "Very Low Sulfur Fuel Oil (VLSFO) - Singapore (SGSIN)",
            "price": 889.5,
            "formatted": "$889.50",
            "currency": "USD",
            "unit": "metric_ton",
            "source": "market_reporting",
            "timestamp": "2026-10-10T03:11:14.303Z",
            "quality_grade": "ISO 8217 RMG380",
            "as_of": "2026-10-09T17:00:00.000Z",
            "collected_at": "2026-10-10T03:11:14.303Z",
            "synthetic": false,
            "stale": true,
            "age_days": 6
          },
          {
            "code": "VLSFO_SGSIN_USD",
            "fuel_type": "VLSFO",
            "fuel_name": "Very Low Sulfur Fuel Oil (VLSFO) - Singapore (SGSIN)",
            "price": 908,
            "formatted": "$908.00",
            "currency": "USD",
            "unit": "metric_ton",
            "source": "market_reporting",
            "timestamp": "2026-10-09T03:11:05.040Z",
            "quality_grade": "ISO 8217 RMG380",
            "as_of": "2026-10-08T17:00:00.000Z",
            "collected_at": "2026-10-09T03:11:05.040Z",
            "synthetic": false,
            "stale": true,
            "age_days": 7
          }
        ]
      }
    ],
    "metadata": {
      "port": "SGSIN",
      "fuel_type": "VLSFO_SGSIN_USD",
      "days": 7,
      "count": 1,
      "period": {
        "start": "2026-10-08T17:18:57Z",
        "end": "2026-10-15T17:18:57Z"
      }
    }
  }
};

/** Verbatim: GET /v1/prices/marine-fuels/historical?port_code=SGSIN&fuel_type=HFO_180_SGSIN_USD&days=30 (SGSIN lists HFO_180 in fuel_services but carries no rows) */
export const LIVE_MARINE_HISTORY_EMPTY = {
  "status": "success",
  "data": {
    "prices": [],
    "metadata": {
      "port": "SGSIN",
      "fuel_type": "HFO_180_SGSIN_USD",
      "days": 30,
      "count": 0,
      "period": {
        "start": "2026-09-15T17:24:17Z",
        "end": "2026-10-15T17:24:17Z"
      }
    }
  }
};
