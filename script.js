function fixStorage() {
	if(navigator.userAgent.search('Chrome') == -1) {
		// Seems like storage.sync doesn't work on Firefox.
		chrome.storage.sync = chrome.storage.local;
		console.log('WARNING: Using local storage.');
	}
}
fixStorage();

var options = {
	voiceType: '',
	voice: null,
	emojisEnabled: true,
	voiceRate: 1.0,
	voicePitch: 1.0,
	voiceVolume: 1.0,
	delay: 0.0
}

function loadOptions() {
	chrome.storage.sync.get({
		// default values
		voiceType: '',
		emojisEnabled: true,
		voiceRate: 1.0,
		voicePitch: 1.0,
		voiceVolume: 1.0,
		delay: 0.0
	}, function(items) {
		options.voiceType = items.voiceType;
		options.emojisEnabled = items.emojisEnabled;
		options.voiceRate = items.voiceRate;
		options.voicePitch = items.voicePitch;
		options.voiceVolume = items.voiceVolume;
		options.delay = items.delay;
		console.log('loadOptions: voice: ' + items.voiceType + ' emojis: ' + items.emojisEnabled + ' rate: ' + items.voiceRate + ' pitch: ' + items.voicePitch + ' volume: ' + items.voiceVolume + ' delay: ' + items.delay);
	});
}
loadOptions();

var voices = [];
function updateVoice() {
	for(i = 0; i < voices.length; i++) {
		// .lang check is for legacy support
		if(voices[i].voiceURI == options.voiceType || voices[i].lang == options.voiceType) {
			options.voice = voices[i];
			console.log('Using voice: ' + voices[i].name + ' (' + voices[i].lang + ')' + ' (local: ' + voices[i].localService + ')')
			return;
		}
	}
	options.voice = voices[0];
}

chrome.storage.onChanged.addListener(function(changes, areaName) {
	for(let k in changes) {
		if(k in options) {
			options[k] = changes[k].newValue;
		}
	}
	console.log('Options changed. Voice: ' + options.voiceType + ' Emojis: ' + options.emojisEnabled + ' rate: ' + options.voiceRate + ' pitch: ' + options.voicePitch + ' volume: ' + options.voiceVolume + ' delay: ' + options.delay);
	updateVoice();
})

class ChatWatcher {
	constructor() {
		this.queue = {};
		this.currentMsg = null;
		this.paused = false;

		// Chat can be detached to popup (however YT still updates messages)
		this.detached = false;
	}

	onSpeechEnd() {
		delete this.queue[this.currentMsg];
		this.currentMsg = null;
		this.delaying = true;
		let _this = this;
		setTimeout(function() {
			_this.delaying = false;
			_this.updateSpeech();
		}, options.delay*1000);
	}

	switchPause() {
		this.paused = !this.paused;
		this.updateSpeech();
	}

	updateSpeech() {
		if(!this.paused && this.currentMsg === null && !this.detached && !this.delaying) {
			if(voices.length == 0) {
				console.log('ERROR: No voices loaded.')
				return;
			}

			if(Object.keys(this.queue).length > 0) {
				let id = Object.keys(this.queue)[0];
				this.currentMsg = id;
				let msg = this.queue[id];
				let msgt = msg[0] + ': "' + msg[1] + '"';
				console.log(msgt + ' (' + Object.keys(this.queue).length + ' in queue)');

				let u = new SpeechSynthesisUtterance(msgt);

				// Don't trust it. It's buggy.
				//u.onend = this.onSpeechEnd;

				u.voice = options.voice;
				u.rate = options.voiceRate;
				u.pitch = options.voicePitch;
				u.volume = options.voiceVolume;
				speechSynthesis.speak(u);

				let startTime = +new Date();
				// Thanks to: https://gist.github.com/mapio/967b6a65b50d39c2ae4f
				let _this = this;
				function _wait() {
					if(!speechSynthesis.speaking) {
						_this.onSpeechEnd();
						return;
					}

					// Long messages can sometimes stop playing and .speaking still returns true
					// Long means vocally long (for example 200*emoji)
					// Thanks to this protection at least the whole reader doesn't break up.
					if((+new Date()) - startTime > 30*1000) {
						console.log('WARNING: Current message was playing longer than 30 seconds and was stopped.');
						speechSynthesis.cancel();
						_this.onSpeechEnd();
						return;
					}
					setTimeout(_wait, 200);
				}
				_wait();
			}
		}
	}

	addToQueue(id, author, msg) {
		//console.log('addToQueue ' + id);
		if(!(id in this.queue) && !this.detached) {
			this.queue[id] = [author, msg];
			this.updateSpeech();
		}
	}

	updateMsgID(id, newId) {
		// Sometimes message with given ID can be already removed.
		if(id in this.queue) {
			//console.log('updateMsgID: ' + id + ' => ' + newId);
			this.queue[newId] = this.queue[id];
			if(this.currentMsg == id) {
				this.currentMsg = newId;
			}
			delete this.queue[id];
		}
	}

	removeMsg(id) {
		if(id in this.queue) {
			//console.log('removeMsg: ' + id);
			if(id == this.currentMsg) {
				// Stop current message
				speechSynthesis.cancel();
				this.currentMsg = null;
			}
			delete this.queue[id];
		}
	}

	onDetachedStateChanged(detached) {
		if(detached != this.detached) {
			this.detached = detached;
			console.log('Chat detached: ' + this.detached);
			if(this.detached) {
				// Chat got detached to external window. We assume user want
				// listen messages in that window, so clear current messages now.
				// If he ever goes back, only new messages should play in that case.
				for(let id in this.queue) {
					this.removeMsg(id);
				}
			}
		}
	}
}

function getTextWithAlts(e) {
	let txt = '';
	e.contents().each(function() {
		if($(this).get(0).nodeType == 1 && $(this).is('img')) {
			// img (emoji), extra space is required to properly read more than 1 emoji in a row
			txt += $(this).attr('alt') + ' ';
		} else {
			// text or span (mentions)
			txt += $(this).text();
		}
	});
	return txt;
}

var watcher = null;
function initWatching() {
	console.log('yt-live-text2speech: initializing...')


	watcher = new ChatWatcher();

	// without .iron-selected = detached chat
	let observer = new MutationObserver(mutationHandler);
	observer.observe($('#chat-messages.style-scope.yt-live-chat-renderer.iron-selected')[0], {
		childList: true,
		characterData: false,
		attributes: true,
		subtree: true,
		attributeOldValue: true,
		attributeFilter: ['is-deleted', 'id', 'class']
	});

	function mutationHandler(mutationRecords) {
		mutationRecords.forEach(function(mutation) {
			if(mutation.attributeName === 'is-deleted') {
				// Message was deleted
				watcher.removeMsg(mutation.target.id);
			}
			else if(mutation.attributeName === 'id') {
				if(mutation.oldValue !== null) {
					// YT gives temporary ID for own messages, which needs to be updated
					watcher.updateMsgID(mutation.oldValue, mutation.target.id);
				}
			}
			else if(mutation.attributeName === 'class' && $(mutation.target).is('#chat-messages')) {
				// Chat got detached/attached
				let detached = $('yt-live-chat-ninja-message-renderer').is('.iron-selected');
				watcher.onDetachedStateChanged(detached);
			}
			else if (mutation.addedNodes !== null) {
				$(mutation.addedNodes).each(function() {
					if ($(this).is('yt-live-chat-text-message-renderer')) {
						let id = $(this)[0].id;
						let author = $(this).find('#author-name').text();

						let msg;
						if(options.emojisEnabled) {
							msg = getTextWithAlts($(this).find('#message'));
						} else {
							msg = $(this).find('#message').text();
						}
						// Check if there is any non-whitespace character
						if (/\S/.test(msg)) {
							watcher.addToQueue(id, author, msg);
						}
					}
				});
			}
		});
	}

	// Handle pause switch
	var keypressed = false;
	function onKeydown(e) {
		$activeElement = $(parent.document.activeElement);
		if(!keypressed && e.which == 32) { // spacebar
			keypressed = true;
			if($('yt-live-chat-text-input-field-renderer').attr('focused') !== '' &&
				!$activeElement.is('input') &&
				!$activeElement.is('textarea')
			) {
				watcher.switchPause();
				e.preventDefault();
			}
		}
		if( e.which == 27 )
			if($('yt-live-chat-text-input-field-renderer').attr('focused') !== '' &&
				!$activeElement.is('input') &&
				!$activeElement.is('textarea')
			){
				speechSynthesis.cancel();
				watcher.queue = {};
			}

	}
	function onKeyup(e) {
		if(keypressed && e.which == 32) {
			keypressed = false;
		}
	}
	function stopSpeech(){

				speechSynthesis.resume();
				watcher.paused = false;
				watcher.updateSpeech();
			}
			// called when we detect sound
			function startSpeech(){
					try{
						speechSynthesis.pause();
						this.paused = true;
						this.updateSpeech();

				}
				catch(e){}
			}
			// request a LocalMediaStream
			navigator.mediaDevices.getUserMedia({audio:true})
			// add our listeners
			.then(stream => detectSilence(stream, stopSpeech, startSpeech))
			.catch(e => console.log(e.message));


			function detectSilence(
				stream,
				onSoundEnd = _=>{},
				onSoundStart = _=>{},
				silence_delay = 500,
				min_decibels = -60
				) {
				const ctx = new AudioContext();
				const analyser = ctx.createAnalyser();
				const streamNode = ctx.createMediaStreamSource(stream);
				streamNode.connect(analyser);
				analyser.minDecibels = min_decibels;

				const data = new Uint8Array(analyser.frequencyBinCount); // will hold our data
				let silence_start = performance.now();
				let triggered = false; // trigger only once per silence event

				function loop(time) {
					requestAnimationFrame(loop); // we'll loop every 60th of a second to check
					analyser.getByteFrequencyData(data); // get current data
					if (data.some(v => v)) { // if there is data above the given db limit
						if(triggered){
							triggered = false;
							onSoundStart();
							}
						silence_start = time; // set it to now
					}
					if (!triggered && time - silence_start > silence_delay) {
						onSoundEnd();
						triggered = true;
					}
				}
				loop();
			}

	$(document).keydown(onKeydown);
	$(parent.document).keydown(onKeydown);
	$(document).keyup(onKeyup);
	$(parent.document).keyup(onKeyup);
}



function loadVoices() {
	if(voices.length == 0) {
		voices = speechSynthesis.getVoices();
		console.log('Loaded ' + voices.length + ' voices.');
		updateVoice();

		if(watcher === null) {
			// Init chat after 2s (simple way to prevent reading old messages)
				setTimeout(initWatching, 2000);
		}
	}
}

$(document).ready(function() {
	console.log('yt-live-text2speech ready!');
	if(speechSynthesis.getVoices().length > 0) {
		loadVoices();
	}

	speechSynthesis.onvoiceschanged = function() {
		// For some reason, this event can fire multiple times (Chromium).
		loadVoices();
	};
});

window.onbeforeunload = function() {
	// Chromium won't stop speaking after closing tab.
	// So shut up, pls.
	speechSynthesis.cancel();
};
