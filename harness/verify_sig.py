import sys, json
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext
res = []
for p in sys.argv[1:]:
    r = {'file': p}
    try:
        with open(p, 'rb') as f:
            rd = PdfFileReader(f)
            sigs = rd.embedded_regular_signatures
            r['sig_count'] = len(sigs)
            for s in sigs:
                st = validate_pdf_signature(s, signer_validation_context=ValidationContext(allow_fetching=False))
                r.setdefault('sigs', []).append({'field': s.field_name, 'byte_range': list(s.byte_range), 'intact': st.intact, 'valid': st.valid,
                  'trusted': st.trusted, 'coverage': str(st.coverage), 'modification_level': str(st.modification_level), 'summary': st.summary()})
    except Exception as e:
        r['error'] = f'{type(e).__name__}: {e}'[:300]
    res.append(r)
print(json.dumps(res, ensure_ascii=False))
