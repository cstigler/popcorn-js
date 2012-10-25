(function( Popcorn, window, document ) {

  function HTMLFlowplayerVideoElement( id ) {
    // Flowplayer iframe API requires postMessage
    if( !window.postMessage ) {
      throw "ERROR: HTMLFlowplayerVideoElement requires window.postMessage";
    }

    var self = this,
      parent = typeof id === "string" ? document.querySelector( id ) : id,
      elem,
      impl = {
        src: EMPTY_STRING,
        networkState: self.NETWORK_EMPTY,
        readyState: self.HAVE_NOTHING,
        seeking: false,
        autoplay: EMPTY_STRING,
        preload: EMPTY_STRING,
        controls: false,
        loop: false,
        poster: EMPTY_STRING,
        volume: -1,
        muted: false,
        currentTime: 0,
        duration: NaN,
        ended: false,
        paused: true,
        width: '100%',
        height: '100%',
        error: null
      },
      playerReady = false,
      player,
      playerReadyCallbacks = [],
      metadataReadyCallbacks = [],
      playerState = -1,
      stateMonitors = {},
      stateMonitorTimeout,
      updateDurationTimeout,
      bufferedInterval,
      lastLoadedFraction = 0,
      currentTimeInterval,
      lastCurrentTime = 0,
      seekTarget = -1,
      timeUpdateInterval,
      forcedLoadMetadata = false;

    // Namespace all events we'll produce
    self._eventNamespace = Popcorn.guid( "HTMLFlowplayerVideoElement::" );

    self.parentNode = parent;

    // Mark this as Flowplayer
    self._util.type = "Flowplayer";

    function addPlayerReadyCallback( callback ) {
      if ( playerReadyCallbacks.indexOf( callback ) < 0 ) {
        playerReadyCallbacks.unshift( callback );
      }
    }

    function onPlayerReady( event ) {
      if ( player === event.target ) {
        playerReady = true;
        while( playerReadyCallbacks.length ) {
          fn = playerReadyCallbacks.pop();
          fn();
        }
      }
    }

    function destroyPlayer() {
      if( !( playerReady && player ) ) {
        return;
      }
      clearInterval( currentTimeInterval );
      clearInterval( bufferedInterval );
      clearTimeout( stateMonitorTimeout );
      clearTimeout( updateDurationTimeout );
      Popcorn.forEach( stateMonitors, function(obj, i) {
        delete stateMonitors[i];
      });

      player.stopVideo();
      if ( player.clearVideo ) {
        player.clearVideo();
      }

      if ( elem && elem.parentNode ) {
        elem.parentNode.removeChild( elem );
      }
      elem = null;
    }

    function changeSrc( aSrc ) {
      if( !self._canPlaySrc( aSrc ) ) {
        impl.error = {
          name: "MediaError",
          message: "Media Source Not Supported",
          code: MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        };
        self.dispatchEvent( "error" );
        return;
      }

      impl.src = aSrc;

      elem = document.createElement( "div" );
      elem.className += " flowplayer";
      elem.width = impl.width;
      elem.height = impl.height;
      
      var video = document.createElement( "video" );
      video.src = aSrc;
      
      elem.appendChild( video );
      
      parent.appendChild( elem );

      player = flowplayer ( elem );

      impl.networkState = self.NETWORK_LOADING;
      self.dispatchEvent( "loadstart" );
      self.dispatchEvent( "progress" );
    }

    function getCurrentTime() {
      if( !player || !player.video ) {
        return 0;
      }
      
      impl.currentTime = player.video.time;

      return impl.currentTime;
    }

    function changeCurrentTime( aTime ) {
      if( !player ) {
        addPlayerReadyCallback( function() { changeCurrentTime( aTime ); } );
        return;
      }

      player.seek( aTime );
    }
    
    function onError(e, err) {      
      err.name = "MediaError";

      impl.error = err;
      
      self.dispatchEvent( "error" );
    }

    function onTimeUpdate( e, player ) {
      self.dispatchEvent( "timeupdate" );
    }

    function onSeeking( e, player ) {
      impl.seeking = true;
      self.dispatchEvent( "seeking" );
    }
    
    function onSeeked( e, player ) {
      impl.seeking = false;
      self.dispatchEvent( "timeupdate" );
      self.dispatchEvent( "seeked" );
    }

    function onPlay( e, player ) {
      impl.paused = false;
      
      self.dispatchEvent( "play" );
      self.dispatchEvent( "playing" );
    }
    
    function onPause( e, player ) {
      impl.paused = true;
      
      self.dispatchEvent( "pause" );
    }
    
    function onVolumeChange( e, player, newLevel ) {
      var muted = player.muted;
      
      impl.
      impl.paused = true;
      
      self.dispatchEvent( "pause" );
    }

    player.bind( "beforeseek", onSeeking);
    player.bind( "error", onError );
    player.bind( "finish", onEnded );
    player.bind( "load", onLoaded );
    player.bind( "mute", onVolumeChange );
    player.bind( "pause", onPause );
    player.bind( "progress", onTimeUpdate );
    player.bind( "ready", onReady );
    player.bind( "resume", onPlaying );
    player.bind( "seek", onSeeked );
    player.bind( "unload", onUnloaded );
    player.bind( "volume", onVolumeChange );

    function onProgress() {
      self.dispatchEvent( "progress" );
    }

    self.play = function() {
      if( !playerReady ) {
        addMetadataReadyCallback( function() { self.play(); } );
        return;
      }
      player.playVideo();
    };

    function onPause() {
      impl.paused = true;
      clearInterval( timeUpdateInterval );
      self.dispatchEvent( "pause" );
    }

    self.pause = function() {
      if( !playerReady ) {
        addMetadataReadyCallback( function() { self.pause(); } );
        return;
      }
      player.pauseVideo();
    };

    function onEnded() {
      if( impl.loop ) {
        changeCurrentTime( 0 );
        self.play();
      } else {
        impl.ended = true;
        self.dispatchEvent( "ended" );
      }
    }

    function setVolume( aValue ) {
      impl.volume = aValue;
      if( !playerReady ) {
        addMetadataReadyCallback( function() {
          setVolume( impl.volume );
        });
        return;
      }
      changeState( "getVolume", player.getVolume(), "volumechange" );
      player.setVolume( aValue );
    }

    function getVolume() {
      if( !playerReady ) {
        return impl.volume > -1 ? impl.volume : 1;
      }
      return player.getVolume();
    }

    function setMuted( aValue ) {
      impl.muted = aValue;
      if( !playerReady ) {
        addMetadataReadyCallback( function() { setMuted( impl.muted ); } );
        return;
      }
      changeState( "isMuted", player.isMuted(), "volumechange" );
      player[ aValue ? "mute" : "unMute" ]();
    }

    function getMuted() {
      // Flowplayer has isMuted(), but for sync access we use impl.muted
      return impl.muted;
    }

    function updateSize() {
      player.setSize( impl.width, impl.height );
    }

    Object.defineProperties( self, {

      src: {
        get: function() {
          return impl.src;
        },
        set: function( aSrc ) {
          if( aSrc && aSrc !== impl.src ) {
            changeSrc( aSrc );
          }
        }
      },

      autoplay: {
        get: function() {
          return impl.autoplay;
        },
        set: function( aValue ) {
          impl.autoplay = self._util.isAttributeSet( aValue );
        }
      },

      loop: {
        get: function() {
          return impl.loop;
        },
        set: function( aValue ) {
          impl.loop = self._util.isAttributeSet( aValue );
        }
      },

      width: {
        get: function() {
          return elem ? elem.width : impl.width || 0;
        },
        set: function( aValue ) {
          impl.width = aValue;
          if (elem) {
            elem.width = aValue;
          }

          if( playerReady ) {
              player.setSize( impl.width, impl.height );
          } else {
              addPlayerReadyCallback( updateSize );
          }
        }
      },

      height: {
        get: function() {
          return elem ? elem.height : impl.height || 0;
        },
        set: function( aValue ) {
          impl.height = aValue;
          if (elem) {
            elem.height = aValue;
          }

          if( playerReady ) {
              player.setSize( impl.width, impl.height );
          } else {
              addPlayerReadyCallback( updateSize );
          }
        }
      },

      currentTime: {
        get: function() {
          return getCurrentTime();
        },
        set: function( aValue ) {
          changeCurrentTime( aValue );
        }
      },

      duration: {
        get: function() {
          return getDuration();
        }
      },

      ended: {
        get: function() {
          return impl.ended;
        }
      },

      paused: {
        get: function() {
          return impl.paused;
        }
      },

      seeking: {
        get: function() {
          return impl.seeking;
        }
      },

      readyState: {
        get: function() {
          return impl.readyState;
        }
      },

      networkState: {
        get: function() {
          return impl.networkState;
        }
      },

      volume: {
        get: function() {
          // Remap from HTML5's 0-1 to Flowplayer's 0-100 range
          return player.volumeLevel;
        },
        set: function( aValue ) {
          player.volume( aValue );
        }
      },

      muted: {
        get: function() {
          return player.muted;
        },
        set: function( aValue ) {
          if( (player.muted && !aValue) || (!player.muted && aValue) ) {
            player.mute();
          }
        }
      },

      error: {
        get: function() {
          return impl.error;
        }
      },

      buffered: {
        get: function () {
          var timeRanges = {
            start: function( index ) {
              if (index === 0) {
                return 0;
              }

              //throw fake DOMException/INDEX_SIZE_ERR
              throw "INDEX_SIZE_ERR: DOM Exception 1";
            },
            end: function( index ) {
              var duration;
              if (index === 0) {
                duration = getDuration();
                if (!duration) {
                  return 0;
                }

                return duration * player.getVideoLoadedFraction();
              }

              //throw fake DOMException/INDEX_SIZE_ERR
              throw "INDEX_SIZE_ERR: DOM Exception 1";
            }
          };

          Object.defineProperties( timeRanges, {
            length: {
              get: function() {
                return 1;
              }
            }
          });

          return timeRanges;
        }
      }
    });

    self._util.getPlaybackQuality = function() {
      return playerReady && player.getPlaybackQuality() || impl.quality || 'default';
    };

    self._util.setPlaybackQuality = function( quality ) {
      impl.quality = quality;

      if( !playerReady ) {
        addMetadataReadyCallback( function() {
          player.setPlaybackQuality( impl.quality );
        });
        return;
      }

      player.setPlaybackQuality( quality );
    };

    self._util.getAvailableQualityLevels = function() {
      return playerReady && player.getAvailableQualityLevels() || [];
    };

  }

  HTMLFlowplayerVideoElement.prototype = new Popcorn._MediaElementProto();
  HTMLFlowplayerVideoElement.prototype.constructor = HTMLFlowplayerVideoElement;

  // Helper for identifying URLs we know how to play.
  HTMLFlowplayerVideoElement.prototype._canPlaySrc = function( url ) {
    return 'maybe';
  };

  // We'll attempt to support a mime type of video/x-Flowplayer
  HTMLFlowplayerVideoElement.prototype.canPlayType = function( type ) {
    return type === "video/x-Flowplayer" ? "probably" : EMPTY_STRING;
  };

  Popcorn.HTMLFlowplayerVideoElement = function( id ) {
    return new HTMLFlowplayerVideoElement( id );
  };
  Popcorn.HTMLFlowplayerVideoElement._canPlaySrc = HTMLFlowplayerVideoElement.prototype._canPlaySrc;

}( Popcorn, window, document ));
