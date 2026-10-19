const $ = (s) => document.querySelector(s);
const fileInput = $('#fileInput'), dropzone = $('#dropzone'), statusEl = $('#status');
let uploadedFile = null, character = 'jack', style = 'storybook';

function setStatus(message, error = false){statusEl.textContent = message;statusEl.classList.toggle('error', error);}
function chooseFile(file){
  if (!file) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) return setStatus('Use a JPG, PNG or WebP photo.', true);
  if (file.size > 6 * 1024 * 1024) return setStatus('Photo must be less than 6 MB.', true);
  uploadedFile = file;
  const url = URL.createObjectURL(file);
  const img = $('#portraitPreview');
  if (img.dataset.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
  img.src = url; img.dataset.blobUrl = url;
  $('#uploadEmpty').hidden = true; $('#uploadFilled').hidden = false;
  setStatus('Your photo is ready for a little magic.');
}
dropzone.addEventListener('click', e => {if(e.target.id !== 'changePhoto') fileInput.click();});
dropzone.addEventListener('keydown', e => {if(e.key === 'Enter' || e.key === ' '){e.preventDefault();fileInput.click();}});
$('#changePhoto').addEventListener('click', e => {e.stopPropagation(); fileInput.click();});
fileInput.addEventListener('change',e => chooseFile(e.target.files[0]));
for (const event of ['dragover','dragenter']) dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.add('drag');});
for (const event of ['dragleave','drop']) dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.remove('drag');});
dropzone.addEventListener('drop',e=>chooseFile(e.dataTransfer.files[0]));
function initSelector(container, prop, callback){document.querySelectorAll(`${container} [data-${prop}]`).forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll(`${container} button`).forEach(b=>b.classList.remove('selected'));button.classList.add('selected');callback(button.dataset[prop]);}));}
initSelector('#characters','character',v=>character=v);
initSelector('#styles','style',v=>style=v);

// Cloudflare FLUX.2 reference images must be below 512x512.
async function downscale(file){
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1,480/Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.round(bitmap.width*scale));
  canvas.height = Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
}
$('#generate').addEventListener('click',async()=>{
  if(!uploadedFile) return setStatus('Please upload a portrait photo first.',true);
  const button = $('#generate');button.disabled = true;button.textContent='✧  Weaving your fairy tale…';setStatus('Creating your enchanted portrait. This may take a moment.');
  try{
    const image = await downscale(uploadedFile);
    if(!image) throw new Error('Could not read that image.');
    const form = new FormData();form.append('image',image,'portrait.png');form.append('character',character);form.append('style',style);
    const response = await fetch('/api/generate',{method:'POST',body:form});
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || 'Generation failed.');
    $('#result').src = data.image;$('#result').hidden = false;$('#placeholder').hidden = true;
    $('#download').href = data.image;$('#download').classList.remove('disabled');$('#download').setAttribute('aria-disabled','false');
    setStatus('✨ Your magical portrait is ready!');
  }catch(error){setStatus(error.message || 'Could not generate an image.',true);}
  finally{button.disabled = false;button.innerHTML='<span class="button-spark">✧</span> Create my fairy tale portrait <span class="arrow">→</span>';}
});
