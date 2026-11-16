# Persian HUD — score, messages, FPS, quality button
extends CanvasLayer

signal quality_toggled

@onready var score_label: Label = $Score
@onready var msg: Label = $Msg
@onready var fps_label: Label = $FPS
@onready var btn: Button = $QBtn

var _msg_t := 0.0

func _ready() -> void:
	btn.pressed.connect(func(): quality_toggled.emit())
	msg.modulate.a = 0.0

func set_score(s: String) -> void:
	score_label.text = s

func flash_message(t: String) -> void:
	msg.text = t
	msg.modulate.a = 1.0
	_msg_t = 3.0

func _process(dt: float) -> void:
	if _msg_t > 0.0:
		_msg_t -= dt
		if _msg_t <= 0.0:
			msg.modulate.a = 0.0
	fps_label.text = "FPS  " + str(Engine.get_frames_per_second())
