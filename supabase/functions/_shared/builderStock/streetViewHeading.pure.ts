/**
 * WHICH WAY THE STREET VIEW CAMERA SHOULD LOOK.
 *
 * Google's Street View still image API defaults to the panorama's own stored
 * orientation when no `heading` is given — which is the direction the capture
 * vehicle happened to be pointing, not the direction of the property. On
 * Lot 13 Hummock Rise, Werribee that produced a side-angle view of the lot:
 * a correct, exact-address photograph aimed down the street.
 *
 * The metadata call the stage already makes returns the PANORAMA's location,
 * and the geocode it already made returns the PROPERTY's location. The bearing
 * from the first to the second is the direction the camera has to face to look
 * at the house, and both numbers are already paid for — so this costs no extra
 * request.
 *
 * IT REFUSES RATHER THAN GUESSES. A missing panorama location, a non-finite
 * number, or a camera sitting essentially on top of the property gives no
 * meaningful direction, and a fabricated heading is worse than Google's
 * default: the default is at least a real orientation of a real panorama.
 * `null` means "send no heading", which preserves exactly the behaviour that
 * shipped before this existed.
 */

/** Below this the two points are the same place and no bearing is meaningful. */
export const MIN_HEADING_DISTANCE_METRES = 4;

export interface LatLng {
  lat: number;
  lng: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Metres between two coordinates. Equirectangular is ample at street scale. */
export function metresBetween(from: LatLng, to: LatLng): number {
  const earthRadius = 6_371_000;
  const meanLat = toRadians((from.lat + to.lat) / 2);
  const x = toRadians(to.lng - from.lng) * Math.cos(meanLat);
  const y = toRadians(to.lat - from.lat);
  return Math.sqrt(x * x + y * y) * earthRadius;
}

/** A finite pair, or null. Google returns these inside an untyped body. */
export function readLatLng(value: unknown): LatLng | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The compass bearing FROM the panorama camera TO the property, 0-360.
 *
 * `null` where the inputs cannot support one, and the caller then sends no
 * heading at all rather than a made-up one.
 */
export function headingToProperty(
  panorama: LatLng | null,
  property: LatLng | null,
): number | null {
  if (!panorama || !property) return null;
  if (metresBetween(panorama, property) < MIN_HEADING_DISTANCE_METRES) return null;

  const fromLat = toRadians(panorama.lat);
  const toLat = toRadians(property.lat);
  const deltaLng = toRadians(property.lng - panorama.lng);

  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat)
    - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  if (!Number.isFinite(bearing)) return null;
  return Math.round(((bearing % 360) + 360) % 360);
}


/**
 * How far a panorama may sit from the property and still be of it.
 *
 * PRODUCTION, 28 AUGUST 2026. Lot 1663 Ringer Street, Lara showed a roundabout
 * on the live Marketplace. Its builder package was correctly identified and
 * then retired on the worker's resource limits, so Stage 3 answered — and Stage
 * 3 had NO usefulness test of any kind: `enrichFromGoogle` asked Google for the
 * nearest panorama to a geocode and accepted whatever came back, at any
 * distance. On a new estate whose own street has never been driven, the nearest
 * panorama is the arterial road it joins.
 *
 * SEVENTY METRES IS THE FRONT OF A HOUSE, NOT THE NEXT STREET. An Australian
 * suburban camera sits on the roadway with the dwelling set back ten to twenty
 * metres, so a genuine street-front still is comfortably inside this. What it
 * excludes is the case that produced the roundabout: no coverage on this street
 * at all and a panorama fetched from somewhere else entirely.
 *
 * The bound is deliberately generous. Refusing a real frontage is a worse
 * outcome than accepting a slightly distant one — but accepting an intersection
 * is worse than both, and blank is the honest answer when the camera has never
 * been near the house.
 */
export const MAX_PANORAMA_DISTANCE_METRES = 70;

export interface PanoramaUsefulness {
  usable: boolean;
  /** Metres from the panorama to the property, where both were known. */
  distanceMetres: number | null;
  reason: string;
}

/**
 * Is this panorama near enough to be a picture of this property?
 *
 * A panorama whose location Google did not state is ACCEPTED, not refused: that
 * is the behaviour which shipped, the metadata has always been optional, and
 * this must not turn a working card blank on a missing field. What it refuses
 * is a location that is stated and far away.
 */
export function assessPanoramaUsefulness(
  panorama: LatLng | null,
  property: LatLng | null,
): PanoramaUsefulness {
  if (!panorama || !property) {
    return {
      usable: true,
      distanceMetres: null,
      reason: 'The panorama did not state where it was taken from.',
    };
  }
  const distanceMetres = Math.round(metresBetween(panorama, property));
  if (distanceMetres > MAX_PANORAMA_DISTANCE_METRES) {
    return {
      usable: false,
      distanceMetres,
      reason: `The nearest Street View panorama is ${distanceMetres} m from this `
        + 'property, too far to be a photograph of it.',
    };
  }
  return { usable: true, distanceMetres, reason: 'Panorama is at the property.' };
}


/**
 * IS THIS GEOCODE OF A PROPERTY, OR OF A SUBURB?
 *
 * `geocodableAddress` now composes a line from the lot and the named estate
 * where the source gave no address column, which is what lets the ladder reach
 * a stock list built the ordinary way. It also creates a hazard the ladder did
 * not have before: if Google has never heard of the estate, it falls back to
 * the locality and answers with the SUBURB CENTRE — and the panorama check
 * below then passes, because the nearest panorama to the middle of a suburb is
 * a street in that suburb. A picture of somewhere else entirely, with every
 * distance guard satisfied.
 *
 * `geocodableAddress` already refuses a place with nothing beside it for
 * exactly this reason. This is the same rule enforced on the ANSWER rather
 * than on the question, which is where it can actually be checked.
 *
 * IT REFUSES COARSENESS, NOT IMPRECISION. A named estate legitimately resolves
 * to a `route`, a `neighborhood`, a `premise` or an `establishment`, and every
 * one of those is a place a camera can be pointed at. What is refused is a
 * result that IS an administrative area: the suburb, the postcode or wider.
 *
 * A result that states no types at all is ACCEPTED — the same rule the
 * panorama check follows, and for the same reason: a missing optional field
 * must never turn a working card blank.
 */
export const COARSE_GEOCODE_TYPES = [
  'locality', 'postal_code', 'postal_code_prefix', 'postal_town',
  'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'administrative_area_level_4',
  'country', 'continent',
] as const;

export interface GeocodePrecision {
  usable: boolean;
  /** The coarse type that refused it, for the row's own error message. */
  coarsestType: string | null;
  reason: string;
}

export function assessGeocodePrecision(result: unknown): GeocodePrecision {
  const types = (result && typeof result === 'object')
    ? (result as { types?: unknown }).types : null;
  if (!Array.isArray(types) || types.length === 0) {
    return {
      usable: true, coarsestType: null,
      reason: 'The location service did not say how precise the match was.',
    };
  }
  const named = types.map((type) => String(type));
  const coarse = named.find(
    (type) => (COARSE_GEOCODE_TYPES as readonly string[]).includes(type));
  if (!coarse) {
    return { usable: true, coarsestType: null, reason: 'Located at the property.' };
  }
  return {
    usable: false,
    coarsestType: coarse,
    reason: 'That address could only be located as far as the surrounding area, '
      + 'so any photograph would be of somewhere else nearby.',
  };
}
