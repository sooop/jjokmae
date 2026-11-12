import sys, os, subprocess
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
out = sys.argv[1]
pdfmetrics.registerFont(UnicodeCIDFont('HYGothic-Medium'))
pdfmetrics.registerFont(UnicodeCIDFont('HYSMyeongJo-Medium'))
c = canvas.Canvas(f'{out}/ko_nonembedded.pdf', pagesize=A4)
lines = ["한글 문서 렌더링 시험: 폰트 미내장 CID 폰트", "자간과 받침 확인 – 값없이 읽는 닭의 꿈, 똠방각하 쌍기역 ㄲㄸㅃㅆㅉ", "1234567890 ABCabc (괄호) “따옴표” ‘작은따옴표’ …말줄임표"]
for p in range(5):
    y = 780
    for font in ['HYGothic-Medium','HYSMyeongJo-Medium']:
        for s in (10,14,20):
            c.setFont(font, s)
            for t in lines:
                c.drawString(50, y, f"[{p+1}] {t}"); y -= s+8
    c.showPage()
c.save()
# embedded via LibreOffice (HTML -> PDF)
html = '<html><body style="font-family:Noto Sans CJK KR">' + ''.join(f'<h2>제{p+1}장 임베디드 폰트 문서</h2><p>' + ('가나다라마바사 아자차카타파하 한글 문서 렌더링 품질 시험입니다. 값없이 읽는 닭의 꿈. ' * 12) + '</p>' for p in range(6)) + '</body></html>'
open(f'{out}/src.html','w').write(html)
subprocess.run(['soffice','--headless','--convert-to','pdf:writer_web_pdf_Export','--outdir',out,f'{out}/src.html'],check=True,capture_output=True)
os.rename(f'{out}/src.pdf', f'{out}/ko_embedded.pdf')
# scan: rasterize and wrap as image-only
subprocess.run(['pdftoppm','-r','200','-jpeg','-jpegopt','quality=70',f'{out}/ko_embedded.pdf',f'{out}/scanpg'],check=True)
from PIL import Image
import glob
imgs=[Image.open(f).convert('RGB') for f in sorted(glob.glob(f'{out}/scanpg-*.jpg'))[:6]]
imgs[0].save(f'{out}/scan.pdf', save_all=True, append_images=imgs[1:], resolution=200)
for f in glob.glob(f'{out}/scanpg-*.jpg')+[f'{out}/src.html']: os.remove(f)
