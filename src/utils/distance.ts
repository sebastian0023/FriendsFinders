export const EARTH_RADIUS_MILES = 3958.8;

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

export function isNearby(lat1: number, lng1: number, lat2: number, lng2: number, radiusMiles: number): boolean {
  return haversine(lat1, lng1, lat2, lng2) <= radiusMiles;
}
