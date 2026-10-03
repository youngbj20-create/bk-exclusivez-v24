// BK Exclusivez reservation + live availability engine.
// The front end talks to server.js. Square payment can be connected later without rebuilding this logic.
const startTimeSelect=document.getElementById('startTime');
const endTimeSelect=document.getElementById('endTime');
const bookingDate=document.getElementById('bookingDate');
const hoursRequested=document.getElementById('hoursRequested');
const bookingForm=document.getElementById('bookingForm');
const availabilityNote=document.getElementById('availabilityNote');
const calGrid=document.getElementById('calGrid');
const calMonth=document.getElementById('calMonth');
const calPrev=document.getElementById('calPrev');
const calNext=document.getElementById('calNext');

const pad=n=>String(n).padStart(2,'0');
const formatTime=minutes=>{
  const h=Math.floor(minutes/60)%24;
  const m=minutes%60;
  const suffix=h>=12?'PM':'AM';
  const displayHour=(h%12)||12;
  return `${displayHour}:${pad(m)} ${suffix}`;
};
const dateKey=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseLocalDate=(s)=>{const [y,m,d]=String(s||'').split('-').map(Number); return y&&m&&d?new Date(y,m-1,d):null};
const startOfDay=s=>{const d=parseLocalDate(s); return d?new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime():null};
const candidateAt=(date,minutes)=>{const d=parseLocalDate(date); if(!d) return null; d.setMinutes(minutes); return d.getTime();};

let busyIntervals=[];
let monthBusyCache={};
let calendarCursor=new Date();
calendarCursor.setDate(1);

async function fetchAvailability(date){
  try{
    const r=await fetch(`/api/availability?date=${encodeURIComponent(date)}`);
    if(!r.ok) throw new Error('availability');
    const data=await r.json();
    busyIntervals=(data.reservations||[]).map(x=>({start:new Date(x.startAt).getTime(),end:new Date(x.endAt).getTime()}));
    return true;
  }catch(e){
    busyIntervals=[];
    availabilityNote.textContent='Live availability is unavailable right now. Please try again in a moment.';
    availabilityNote.classList.add('error');
    return false;
  }
}
function conflicts(startMs,endMs){return busyIntervals.some(x=>startMs<x.end && endMs>x.start)}
function hasMinimumOpening(date,startMinutes){return !conflicts(candidateAt(date,startMinutes),candidateAt(date,startMinutes+180))}
function hasAnyOpening(date){for(let m=0;m<=1260;m+=30){if(hasMinimumOpening(date,m)) return true} return false}

async function fillStartTimes(){
  if(!startTimeSelect) return;
  startTimeSelect.innerHTML='<option value="">Choose start time</option>';
  const date=bookingDate?.value;
  if(!date) return;
  for(let minutes=0;minutes<1440;minutes+=30){
    if(!hasMinimumOpening(date,minutes)) continue;
    const option=document.createElement('option');
    option.value=formatTime(minutes);
    option.textContent=formatTime(minutes);
    option.dataset.minutes=minutes;
    startTimeSelect.appendChild(option);
  }
  if(startTimeSelect.options.length===1){
    availabilityNote.textContent='No 3-hour booking windows remain on this date.';
    availabilityNote.classList.add('full');
  }
}

function fillEndTimes(){
  if(!endTimeSelect) return;
  endTimeSelect.innerHTML='<option value="">Choose end time</option>';
  const date=bookingDate?.value;
  const selected=startTimeSelect?.selectedOptions?.[0];
  const startMinutes=selected?.dataset?.minutes;
  if(!date || startMinutes===undefined || startMinutes==='') return;
  const start=Number(startMinutes);
  for(let absolute=start+180;absolute<=start+720;absolute+=30){
    const startMs=candidateAt(date,start);
    const endMs=candidateAt(date,absolute);
    if(conflicts(startMs,endMs)) continue;
    const option=document.createElement('option');
    option.value=formatTime(absolute);
    option.textContent=`${formatTime(absolute)}${absolute>=1440?' (next day)':''}`;
    option.dataset.minutes=absolute;
    endTimeSelect.appendChild(option);
  }
  if(endTimeSelect.options[1]) endTimeSelect.selectedIndex=1;
}

function getBookingHours(){
  const s=startTimeSelect?.selectedOptions?.[0]?.dataset?.minutes;
  const e=endTimeSelect?.selectedOptions?.[0]?.dataset?.minutes;
  if(s===undefined||e===undefined) return null;
  const diff=Number(e)-Number(s);
  return diff>=180?diff/60:null;
}
function updateCalculatedHours(){
  if(!hoursRequested) return;
  const hours=getBookingHours();
  if(hours===null){hoursRequested.value='';hoursRequested.placeholder='Calculated from start & end time';updatePriceSummary();return}
  hoursRequested.value=`${hours} ${hours===1?'Hour':'Hours'}`;
  updatePriceSummary();
}

const PRICE_PER_HOUR=65;
const CONFIRMATION_DEPOSIT=100;
const ADD_ON_PRICES={smoking:150,quickflicks:85,photo:200,video:75};
const totalPriceEl=document.getElementById('totalPrice');
const priceBreakdownEl=document.getElementById('priceBreakdown');
const balanceDueEl=document.getElementById('balanceDue');
const depositLine=document.getElementById('depositLine');
const balanceLine=document.getElementById('balanceLine');
const priceNote=document.getElementById('priceNote');
const bookingSubmit=document.getElementById('bookingSubmit');
const formNote=document.getElementById('formNote');
const bookingPolicy=document.getElementById('bookingPolicy');
const money=n=>`$${Number(n).toFixed(2)}`;
function updatePriceSummary(){
  if(!totalPriceEl||!priceBreakdownEl||!balanceDueEl) return;
  const service=document.querySelector('[name="service"]')?.value||'';
  const isAirport=service.startsWith('Airport Pickup / Drop-Off');
  if(isAirport){
    totalPriceEl.textContent='Price upon inquiry';
    balanceDueEl.textContent='Price upon inquiry';
    if(depositLine) depositLine.style.display='none';
    if(balanceLine) balanceLine.style.display='none';
    if(priceNote) priceNote.textContent='Airport service is price upon inquiry. No deposit is collected through the website.';
    if(bookingSubmit) bookingSubmit.textContent='Request Airport Quote';
    if(formNote) formNote.textContent='Submitting sends your airport transportation request for a custom quote. No payment is required online.';
    if(bookingPolicy) bookingPolicy.innerHTML='Airport Pickup / Drop-Off is <strong>price upon inquiry</strong>. No deposit is required through the website. We will contact you with your quote.';
    priceBreakdownEl.innerHTML='<div class="price-breakdown-row"><span>Airport Pickup / Drop-Off</span><strong>Price upon inquiry</strong></div>';
    return;
  }
  if(depositLine) depositLine.style.display='';
  if(balanceLine) balanceLine.style.display='';
  if(priceNote) priceNote.textContent='The $100 deposit is applied toward your reservation total and confirms the booking.';
  if(bookingSubmit) bookingSubmit.textContent='Continue to $100 Deposit';
  if(formNote) formNote.textContent='Submitting prepares your reservation request. Payment is what finalizes the reservation.';
  if(bookingPolicy) bookingPolicy.innerHTML='Black Truck reservations require a <strong>$100 deposit</strong> to finalize. The remaining balance is due <strong>3 hours before pickup.</strong>';
  const hours=getBookingHours();
  if(hours===null){totalPriceEl.textContent='$0.00';balanceDueEl.textContent='—';priceBreakdownEl.innerHTML='<p>Select your start and end time to see your price breakdown.</p>';return;}
  const fullHours=Math.floor(hours), halfHours=hours-fullHours;
  const fullCharge=fullHours*PRICE_PER_HOUR, halfCharge=halfHours*PRICE_PER_HOUR;
  let total=fullCharge+halfCharge, lines=[];
  if(fullHours) lines.push(`<div class="price-breakdown-row"><span>${fullHours} hour${fullHours===1?'':'s'} × $65</span><strong>${money(fullCharge)}</strong></div>`);
  if(halfHours) lines.push(`<div class="price-breakdown-row"><span>0.5 hour × $65</span><strong>${money(halfCharge)}</strong></div>`);
  const labels={smoking:'Smoking Fee',quickflicks:'Quick Flicks',photo:'Full Photography',video:'Quick Video'};
  Object.entries(ADD_ON_PRICES).forEach(([name,price])=>{const input=bookingForm?.querySelector(`[name="${name}"]`);if(input?.checked){total+=price;lines.push(`<div class="price-breakdown-row"><span>${labels[name]}</span><strong>+${money(price)}</strong></div>`);}});
  if(bookingForm?.querySelector('[name="bottle"]')?.checked) lines.push('<div class="price-breakdown-row"><span>Bottle Service</span><strong>Price upon inquiry</strong></div>');
  if(bookingForm?.querySelector('[name="flowers"]')?.checked) lines.push('<div class="price-breakdown-row"><span>Flowers</span><strong>Price upon inquiry</strong></div>');
  totalPriceEl.textContent=money(total);balanceDueEl.textContent=money(Math.max(total-CONFIRMATION_DEPOSIT,0));priceBreakdownEl.innerHTML=lines.join('');
}

// Custom availability calendar. Fully booked dates are disabled; open dates remain selectable.
async function loadMonthAvailability(monthDate){
  const month=`${monthDate.getFullYear()}-${pad(monthDate.getMonth()+1)}`;
  if(monthBusyCache[month]) return monthBusyCache[month];
  try{const r=await fetch(`/api/month-availability?month=${month}`);if(!r.ok) throw new Error();const data=await r.json();monthBusyCache[month]=data.reservations||[];return monthBusyCache[month];}
  catch{return [];}
}
async function renderCalendar(){
  if(!calGrid||!calMonth) return;
  const y=calendarCursor.getFullYear(),m=calendarCursor.getMonth();
  calMonth.textContent=new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(calendarCursor);
  calGrid.innerHTML='';
  const monthRows=await loadMonthAvailability(calendarCursor);
  const first=new Date(y,m,1), days=new Date(y,m+1,0).getDate(), offset=first.getDay();
  for(let i=0;i<offset;i++){const blank=document.createElement('span');blank.className='cal-day blank';calGrid.appendChild(blank)}
  const today=new Date();today.setHours(0,0,0,0);
  for(let day=1;day<=days;day++){
    const d=new Date(y,m,day); const key=dateKey(d); const btn=document.createElement('button');btn.type='button';btn.className='cal-day';btn.textContent=day;
    if(d<today){btn.disabled=true;btn.classList.add('past')}
    const busy=monthRows.filter(x=>{const s=new Date(x.startAt).getTime(),e=new Date(x.endAt).getTime();const ds=new Date(y,m,day).getTime(),de=new Date(y,m,day+1).getTime();return s<de&&e>ds});
    const hasOpen=(()=>{for(let start=0;start<=1260;start+=30){const s=candidateAt(key,start),e=candidateAt(key,start+180);if(!busy.some(x=>s<new Date(x.endAt).getTime()&&e>new Date(x.startAt).getTime()))return true}return false})();
    if(!hasOpen&&!btn.disabled){btn.disabled=true;btn.classList.add('full')}
    if(bookingDate?.value===key) btn.classList.add('selected');
    if(!btn.disabled) btn.addEventListener('click',async()=>{bookingDate.value=key;calendarCursor=new Date(y,m,1);document.querySelectorAll('.cal-day.selected').forEach(x=>x.classList.remove('selected'));btn.classList.add('selected');await refreshForDate();});
    calGrid.appendChild(btn);
  }
}
async function refreshForDate(){
  if(!bookingDate?.value) return;
  availabilityNote.classList.remove('error','full');
  availabilityNote.textContent='Checking live availability…';
  const ok=await fetchAvailability(bookingDate.value);if(!ok)return;
  await fillStartTimes();fillEndTimes();updateCalculatedHours();
  if(startTimeSelect.options.length>1) availabilityNote.textContent='Times shown are currently available.';
  renderCalendar();
}

if(bookingDate){
  const today=new Date();today.setHours(0,0,0,0);bookingDate.min=dateKey(today);
  bookingDate.addEventListener('change',()=>{if(bookingDate.value){const d=parseLocalDate(bookingDate.value);calendarCursor=new Date(d.getFullYear(),d.getMonth(),1);refreshForDate();}});
}
if(calPrev) calPrev.addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()-1);renderCalendar()});
if(calNext) calNext.addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()+1);renderCalendar()});
if(startTimeSelect) startTimeSelect.addEventListener('change',()=>{fillEndTimes();updateCalculatedHours()});
if(endTimeSelect) endTimeSelect.addEventListener('change',updateCalculatedHours);
if(bookingForm){
  bookingForm.querySelectorAll('input[type="checkbox"]').forEach(i=>i.addEventListener('change',updatePriceSummary));
  document.querySelector('[name="service"]')?.addEventListener('change',updatePriceSummary);
}

// Submit a temporary 15-minute hold. Square confirmation will convert this to a permanent reservation later.
bookingForm?.addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData(e.currentTarget);
  const service=String(f.get('service')||'');
  const isAirport=service.startsWith('Airport Pickup / Drop-Off');
  const hours=getBookingHours();
  if(!bookingDate.value||hours===null){alert('Please choose an available date, start time, and end time of at least 3 hours.');return;}
  const endMinutes=Number(endTimeSelect.selectedOptions[0].dataset.minutes);
  const total=isAirport?0:(Number((totalPriceEl.textContent||'0').replace(/[^0-9.]/g,''))||0);
  const stops=[...document.querySelectorAll('.stop-input')].map(i=>i.value.trim()).filter(Boolean);
  const payload={name:f.get('name'),phone:f.get('phone'),occasion:f.get('occasion')||'',service,date:f.get('date'),start_time:f.get('start_time'),end_time:f.get('end_time'),end_minutes:endMinutes,total,passengers:f.get('passengers'),pickup:f.get('pickup'),dropoff:f.get('dropoff'),stops};
  const button=e.currentTarget.querySelector('button[type="submit"]');
  if(button){button.disabled=true;button.textContent=isAirport?'Sending Quote Request…':'Checking availability…';}
  try{
    if(isAirport){
      const msg=`BK EXCLUSIVEZ AIRPORT QUOTE REQUEST\n\nName: ${payload.name}\nPhone: ${payload.phone}\nDate: ${payload.date}\nStart: ${payload.start_time}\nEnd: ${payload.end_time}\nHours: ${hours}\nPassengers: ${payload.passengers}\nPickup: ${payload.pickup}\nStops: ${stops.length?stops.map((s,i)=>`${i+1}. ${s}`).join(' | '):'None'}\nDrop-Off: ${payload.dropoff}\n\nAirport service is price upon inquiry. No deposit is required online.`;
      const quoteResponse=await fetch('/api/airport-quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const quoteData=await quoteResponse.json();
      if(!quoteResponse.ok) throw new Error(quoteData.error||'Unable to submit the airport quote request.');
      alert('Your airport quote request has been sent. No deposit is required. We will contact you with pricing.');
      window.location.href='sms:+19145621083?body='+encodeURIComponent(msg);
      return;
    }
    const r=await fetch('/api/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await r.json();
    if(!r.ok) throw new Error(data.error||'That time is no longer available.');
    const expires=new Date(data.expiresAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    const msg=`BK EXCLUSIVEZ BOOKING REQUEST\n\nName: ${payload.name}\nPhone: ${payload.phone}\nDate: ${payload.date}\nStart: ${payload.start_time}\nEnd: ${payload.end_time}\nHours: ${hours}\nEstimated Total: ${totalPriceEl?.textContent}\nConfirmation Deposit: $100.00\nEstimated Remaining Balance: ${balanceDueEl?.textContent}\nPassengers: ${payload.passengers}\nPickup: ${payload.pickup}\nStops: ${stops.length?stops.map((s,i)=>`${i+1}. ${s}`).join(' | '):'None'}\nDrop-Off: ${payload.dropoff}\n\nA temporary hold has been placed until ${expires}. Square payment will finalize the reservation once connected.`;
    alert(`Your time is temporarily held until ${expires}.\n\nSquare payment is not connected yet, so the reservation is not permanently confirmed.`);
    window.location.href='sms:+19145621083?body='+encodeURIComponent(msg);
    monthBusyCache={};await refreshForDate();
  }catch(err){alert(err.message||'Unable to submit that request. Please try again.');}
  finally{if(button){button.disabled=false;button.textContent=isAirport?'Request Airport Quote':'Continue to $100 Deposit';}}
});

// Add optional stops dynamically.
const addStopBtn=document.getElementById('addStopBtn'),stopsContainer=document.getElementById('stopsContainer');
if(addStopBtn&&stopsContainer){let stopCount=1;addStopBtn.addEventListener('click',()=>{stopCount++;const input=document.createElement('input');input.type='text';input.name='stop';input.className='stop-input';input.id=`stop-${stopCount}`;input.placeholder=`Optional stop ${stopCount} address`;input.autocomplete='street-address';stopsContainer.appendChild(input);input.focus();});}

// Highlight the navigation section currently in view.
const navLinks=[...document.querySelectorAll('.nav nav a')];
const sections=navLinks.map(link=>document.querySelector(link.getAttribute('href'))).filter(Boolean);
const setActiveSection=id=>navLinks.forEach(link=>link.classList.toggle('active',link.getAttribute('href')==='#'+id));
const sectionObserver=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(visible)setActiveSection(visible.target.id);},{rootMargin:'-25% 0px -55% 0px',threshold:[0,.15,.35,.6]});
sections.forEach(section=>sectionObserver.observe(section));
const bookLink=document.querySelector('.nav-book'),bookSection=document.querySelector('#book');
if(bookLink&&bookSection){new IntersectionObserver(entries=>{bookLink.style.color=entries[0].isIntersecting?'var(--gold2)':''},{rootMargin:'-20% 0px -60% 0px',threshold:0}).observe(bookSection)}

renderCalendar();
updatePriceSummary();
