"""Structured request/evidence adapter; not an authenticated IHG API client."""
import argparse
import json
import re
from datetime import date, datetime, timezone
from urllib.parse import urlencode, urlparse

# Brand slug and hotel code must be taken from an official IHG hotel page.
STATUSES = {'AVAILABLE', 'UNAVAILABLE', 'BLOCKED', 'UNKNOWN', 'STALE'}

def request(data):
    if not isinstance(data, dict):
        raise ValueError('request must be an object')
    hotel = data.get('hotel')
    brand = data.get('brand')
    if not isinstance(hotel, str) or not re.fullmatch(r'[A-Z0-9]{5}', hotel):
        raise ValueError('official five-character hotel code required')
    if not isinstance(brand, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', brand):
        raise ValueError('official brand URL slug required')
    ci, co = date.fromisoformat(data['checkin']), date.fromisoformat(data['checkout'])
    if co <= ci:
        raise ValueError('checkout must follow checkin')
    for key, default in [('adults', 2), ('rooms', 1), ('children', 0)]:
        value = data.get(key, default)
        if type(value) is not int or value < (0 if key == 'children' else 1):
            raise ValueError('invalid ' + key)
    if data.get('children', 0) != 0:
        raise ValueError('child age handling not implemented')
    canonical = dict(hotel=hotel, brand=brand, checkin=ci.isoformat(), checkout=co.isoformat(),
                     adults=data.get('adults', 2), rooms=data.get('rooms', 1), children=0,
                     rate_type='PURE_POINTS', nights=(co-ci).days)
    params = {'fromRedirect':'true', 'qSlH':hotel, 'qRms':canonical['rooms'],
              'qAdlt':canonical['adults'], 'qChld':0, 'qCiD':ci.day,
              'qCiMy':f'{ci.month-1:02d}{ci.year}', 'qCoD':co.day,
              'qCoMy':f'{co.month-1:02d}{co.year}', 'qRtP':'RWD01'}
    return dict(schema_version=1, request=canonical,
                search_url='https://www.ihg.com/hotels/us/en/reservation',
                query_parameters=params, entry_strategy='UI_FORM_REQUIRED',
                warning='Inputs are not applied by this entry URL. Fill and verify the visible search form.',
                adapter_status='BROWSER_REQUIRED')

def validate(expected, evidence, now=None, max_age_seconds=3600):
    """Validate caller-supplied browser observations. Does not establish provenance."""
    def result(status, reason):
        return dict(schema_version=1, status=status, reason=reason)
    canonical = request(expected)['request']
    if not isinstance(evidence, dict):
        return result('UNKNOWN', 'non-object evidence')
    status = evidence.get('status')
    if not isinstance(status, str):
        return result('UNKNOWN', 'invalid status type')
    if status in {'BLOCKED', 'UNKNOWN'}:
        return result(status, str(evidence.get('reason', 'No verified quote')))
    if status not in {'AVAILABLE', 'UNAVAILABLE'}:
        return result('UNKNOWN', 'invalid status')
    observed = evidence.get('request')
    if (not isinstance(observed, dict) or observed != canonical
            or any(type(observed.get(k)) is not type(v) for k, v in canonical.items())):
        return result('UNKNOWN', 'exact request mismatch')
    try:
        timestamp = datetime.fromisoformat(evidence['checked_at'].replace('Z', '+00:00'))
        if timestamp.tzinfo is None:
            raise ValueError('timezone required')
        age = ((now or datetime.now(timezone.utc)) - timestamp).total_seconds()
        if age < -60:
            return result('UNKNOWN', 'future timestamp')
        if age > max_age_seconds:
            return result('STALE', 'observation expired')
        url = urlparse(evidence['source_url'])
        if url.scheme != 'https' or url.hostname not in {'www.ihg.com', 'ihg.com'} or url.username or url.password:
            raise ValueError('official HTTPS source required')
    except (KeyError, ValueError, TypeError, AttributeError):
        return result('UNKNOWN', 'invalid timestamp or source')
    if not isinstance(evidence.get('evidence_ref'), str) or not evidence['evidence_ref'].strip():
        return result('UNKNOWN', 'missing observation reference')
    if status == 'UNAVAILABLE':
        if evidence.get('explicit_no_availability') is True:
            return result('UNAVAILABLE', 'supplied unavailability evidence passed validation; live provenance must be verified by caller')
        return result('UNKNOWN', 'no explicit availability evidence')
    quote = evidence.get('quote')
    if not isinstance(quote, dict):
        return result('UNKNOWN', 'missing quote')
    for key in ('room', 'bedding', 'cancellation', 'fees_description'):
        if not isinstance(quote.get(key), str) or not quote[key].strip():
            return result('UNKNOWN', 'missing ' + key)
    if quote.get('rate_type') != 'PURE_POINTS' or quote.get('total_scope') != 'FULL_STAY':
        return result('UNKNOWN', 'wrong rate or total scope')
    if type(quote.get('points_total')) is not int or quote['points_total'] <= 0:
        return result('UNKNOWN', 'invalid points total')
    if quote.get('fees_checked') is not True or quote.get('available') is not True:
        return result('UNKNOWN', 'fees or availability not confirmed')
    out = result('AVAILABLE', 'supplied evidence passed validation; live provenance must be verified by caller')
    out.update(quote=quote, checked_at=evidence['checked_at'], source_url=evidence['source_url'])
    return out

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['request', 'validate'])
    parser.add_argument('input', help='JSON file; keep private trip inputs out of Git')
    args = parser.parse_args()
    try:
        with open(args.input) as f:
            data = json.load(f)
        output = request(data) if args.operation == 'request' else validate(data['request'], data['evidence'])
        print(json.dumps(output, indent=2))
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(json.dumps({'status':'UNKNOWN','reason':str(exc)}))
        raise SystemExit(2)

if __name__ == '__main__':
    main()
