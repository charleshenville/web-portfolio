flwr_path = __file__.replace("n.py", "flwrs.txt")
with open(flwr_path, "r") as f:
    flwrs = f.read().splitlines()
    flwrs = [flwr.strip().lower() for flwr in flwrs]

fllwing_path = __file__.replace("n.py", "fllwing.txt")
with open(fllwing_path, "r") as f:
    fllwing = f.read().splitlines()
    fllwing = [fllwing.strip().lower() for fllwing in fllwing]
    
flwrs=set(flwrs)
fllwing=set(fllwing)

def get_flwrs():
    return flwrs

def get_fllwing():
    return fllwing

def get_not_fllwing():
    return flwrs - fllwing

def get_not_flwrs():
    return fllwing - flwrs

def get_common():
    return flwrs & fllwing

def get_not_common():
    return flwrs ^ fllwing

if __name__ == "__main__":
    print(len(get_not_flwrs()))
    print(get_not_flwrs())