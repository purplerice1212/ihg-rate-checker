import copy
import unittest
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
from adapter import request, validate

class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.req = dict(hotel='ABCDE',brand='example-brand',checkin='2030-12-31',checkout='2031-01-02',adults=2,rooms=1)
        self.now = datetime(2030, 1, 1, tzinfo=timezone.utc)
        self.ev = dict(status='AVAILABLE',request=request(self.req)['request'],checked_at='2030-01-01T00:00:00Z',
            source_url='https://www.ihg.com/example', evidence_ref='synthetic-fixture-not-live',
            quote=dict(room='Twin',bedding='2 twin',cancellation='Fixture policy',fees_description='Fixture checked',
                       rate_type='PURE_POINTS',total_scope='FULL_STAY',points_total=90000,fees_checked=True,available=True))
    def check(self, ev, status):
        self.assertEqual(validate(self.req,ev,now=self.now)['status'],status)
    def test_valid(self): self.check(self.ev,'AVAILABLE')
    def test_months(self):
        q=request(self.req)['query_parameters']
        self.assertEqual(q['qCiMy'],'112030'); self.assertEqual(q['qCoMy'],'002031')
    def test_bad_dates(self):
        with self.assertRaises(ValueError): request(dict(self.req,checkout='2030-01-01'))
    def test_bad_occupancy(self):
        for bad in (0,True,'2'):
            with self.assertRaises(ValueError): request(dict(self.req,adults=bad))
    def test_mismatch(self):
        self.ev['request']['adults']=1; self.check(self.ev,'UNKNOWN')
    def test_missing_fields(self):
        for key in list(self.ev['quote']):
            ev=copy.deepcopy(self.ev); del ev['quote'][key]; self.check(ev,'UNKNOWN')
    def test_wrong_totals(self):
        for bad in (True,0,-1,'90000',90000.5):
            self.ev['quote']['points_total']=bad; self.check(self.ev,'UNKNOWN')
    def test_stale(self):
        self.ev['checked_at']='2029-01-01T00:00:00Z'; self.check(self.ev,'STALE')
    def test_bad_timestamp(self):
        for bad in ('fixture','2030-01-01','2031-01-01T00:00:00Z',None):
            self.ev['checked_at']=bad; self.check(self.ev,'UNKNOWN')
    def test_sources(self):
        for bad in ('https://ihg.com.evil.com','http://www.ihg.com','https://user:pass@ihg.com'):
            self.ev['source_url']=bad; self.check(self.ev,'UNKNOWN')
    def test_failures_not_soldout(self):
        for bad in ({},'<html>404</html>',{'status':'BLOCKED','reason':'login required'}):
            self.check(bad,'BLOCKED' if isinstance(bad,dict) and bad.get('status')=='BLOCKED' else 'UNKNOWN')
    def test_unavailable(self):
        self.ev['status']='UNAVAILABLE'; self.check(self.ev,'UNKNOWN')
        self.ev['explicit_no_availability']=True; self.check(self.ev,'UNAVAILABLE')
    def test_cash_or_nightly_rejected(self):
        self.ev['quote']['rate_type']='CASH_PLUS_POINTS'; self.check(self.ev,'UNKNOWN')
        self.ev['quote']['rate_type']='PURE_POINTS'; self.ev['quote']['total_scope']='NIGHTLY'; self.check(self.ev,'UNKNOWN')

if __name__ == '__main__': unittest.main()
