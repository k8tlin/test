'use strict'
// Postcode handling. Distances are approximate: they are measured in a straight
// line from the centre of the postcode district (e.g. "E8"), not from the door.

const data = require('../seed-data.json')
const { UK_POSTCODE, UK_OUTWARD } = require('../security/validate')

const DISTRICTS = data.districts // "E8" -> { lat, lon }
const AREAS = data.areas // "E" -> { lat, lon, label }

/**
 * @param {string} input  "E8 4PH", "e84ph", "E8", "N1C"...
 * @returns {{ ok: true, outward, area, district, label, lat, lon, precise, full } | { ok: false, reason: 'format'|'not_london' }}
 */
function resolvePostcode (input) {
  const value = String(input || '').trim().toUpperCase().replace(/\s+/g, ' ')
  let outward = null
  let full = null
  const m = UK_POSTCODE.exec(value)
  if (m) {
    outward = m[1]
    full = `${m[1]} ${m[2]}`
  } else if (UK_OUTWARD.test(value.replace(/ /g, ''))) {
    outward = value.replace(/ /g, '')
  }
  if (!outward) return { ok: false, reason: 'format' }

  const area = /^[A-Z]{1,2}/.exec(outward)[0]
  if (!AREAS[area]) return { ok: false, reason: 'not_london' }

  // Exact district ("E8"), then the district without its trailing letter
  // ("SW1A" -> "SW1"), then the centre of the whole postcode area ("E").
  const candidates = [outward, outward.replace(/[A-Z]$/, '')]
  for (const key of candidates) {
    if (DISTRICTS[key]) {
      return { ok: true, outward, area, district: outward, label: outward, lat: DISTRICTS[key].lat, lon: DISTRICTS[key].lon, precise: true, full }
    }
  }
  return { ok: true, outward, area, district: outward, label: AREAS[area].label, lat: AREAS[area].lat, lon: AREAS[area].lon, precise: false, full }
}

/** Straight-line distance in miles (same approximation as the design reference). */
function miles (lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180
  const x = (lon2 - lon1) * rad * Math.cos((lat1 + lat2) / 2 * rad)
  const y = (lat2 - lat1) * rad
  return Math.sqrt(x * x + y * y) * 3959
}

const roundMiles = (value) => Math.round(value * 10) / 10

function distanceTo (place, roasterLat, roasterLon) {
  return roundMiles(miles(place.lat, place.lon, roasterLat, roasterLon))
}

module.exports = { resolvePostcode, miles, distanceTo }
