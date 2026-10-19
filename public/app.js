const $ = (s) => document.querySelector(s);
const fileInput = $('#fileInput'), dropzone = $('#dropzone'), statusEl = $('#status');
const BUTTON_HTML = '<span class="button-spark"></span> Create my scene <span class="arrow">→</span>';
let uploadedFile = null, scene = 'planting';

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
  setStatus('Your photo is ready. Pick a scene.');
}
dropzone.addEventListener('click', e => {if(e.target.id !== 'changePhoto') fileInput.click();});
dropzone.addEventListener('keydown', e => {if(e.key === 'Enter' || e.key === ' '){e.preventDefault();fileInput.click();}});
$('#changePhoto').addEventListener('click', e => {e.stopPropagation(); fileInput.click();});
fileInput.addEventListener('change',e => chooseFile(e.target.files[0]));
for (const event of ['dragover','dragenter']) dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.add('drag');});
for (const event of ['dragleave','drop']) dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.remove('drag');});
dropzone.addEventListener('drop',e=>chooseFile(e.dataTransfer.files[0]));

document.querySelectorAll('#scenes [data-scene]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('#scenes button').forEach(b => {b.classList.remove('selected'); b.setAttribute('aria-pressed','false');});
  button.classList.add('selected'); button.setAttribute('aria-pressed','true');
  scene = button.dataset.scene;
}));

// The server finds the face and crops the reference itself, so send a sharp (not tiny) photo.
async function prepareUpload(file){
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.round(bitmap.width*scale));
  canvas.height = Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  return await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.92));
}

$('#generate').addEventListener('click',async()=>{
  if(!uploadedFile) return setStatus('Please upload a photo of your face first.',true);
  const button = $('#generate');button.disabled = true;button.textContent='Painting your scene…';
  setStatus('Painting and checking your picture. This can take up to a minute.');
  try{
    const image = await prepareUpload(uploadedFile);
    if(!image) throw new Error('Could not read that image.');
    const form = new FormData();form.append('image',image,'portrait.jpg');form.append('scene',scene);
    const response = await fetch('/api/generate',{method:'POST',body:form});
    const data = await response.json().catch(()=>({error:'The server sent an unexpected reply.'}));
    if(!response.ok) throw new Error(data.error || 'Generation failed.');
    $('#result').src = data.image;$('#result').hidden = false;$('#placeholder').hidden = true;
    $('#caption').textContent = data.caption;
    $('#captionSub').textContent = 'Checked: looks like you, and matches the scene.';
    $('#download').href = data.image;$('#download').download = `jack-${data.scene}.${data.image.startsWith('data:image/jpeg')?'jpg':'png'}`;
    $('#download').classList.remove('disabled');$('#download').setAttribute('aria-disabled','false');
    setStatus('✨ Your scene is ready!');
  }catch(error){setStatus(error.message || 'Could not generate an image.',true);}
  finally{button.disabled = false;button.innerHTML=BUTTON_HTML;}
});
