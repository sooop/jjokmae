# 항목3,4 시험 PDF 생성 (harness/.venv 의 reportlab, pyhanko 사용)
import subprocess, os, io
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
OUT = 'out2/fixtures'; os.makedirs(OUT, exist_ok=True)
# 양식 PDF: 텍스트 필드 2개 (name, memo)
c = canvas.Canvas(f'{OUT}/form.pdf', pagesize=A4)
c.setFont('Helvetica', 14); c.drawString(50, 780, 'Form test: name / memo')
c.drawString(50, 735, 'name:'); c.drawString(50, 695, 'memo:')
c.acroForm.textfield(name='name', x=120, y=725, width=300, height=24, borderStyle='solid', fontSize=12, value='', forceBorder=True)
c.acroForm.textfield(name='memo', x=120, y=685, width=300, height=24, borderStyle='solid', fontSize=12, value='', forceBorder=True)
c.showPage(); c.save()
# 자체 서명 인증서
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',f'{OUT}/key.pem','-out',f'{OUT}/cert.pem','-days','30','-subj','/CN=Harness Test'],check=True,capture_output=True)
subprocess.run(['openssl','pkcs12','-export','-inkey',f'{OUT}/key.pem','-in',f'{OUT}/cert.pem','-out',f'{OUT}/test.p12','-passout','pass:test'],check=True,capture_output=True)
from pyhanko.sign import signers, fields
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
with open(f'{OUT}/form.pdf','rb') as f:
    w = IncrementalPdfFileWriter(f)
    fields.append_signature_field(w, fields.SigFieldSpec(sig_field_name='Sig1', box=(50, 600, 250, 660)))
    signer = signers.SimpleSigner.load_pkcs12(f'{OUT}/test.p12', passphrase=b'test')
    meta = signers.PdfSignatureMetadata(field_name='Sig1')
    with open(f'{OUT}/signed.pdf','wb') as o:
        signers.sign_pdf(w, meta, signer=signer, output=o)
print('ok')
